import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { CageConfig } from '../config.ts';
import { cageHome, PKG_ROOT, readJson, sleep, writeJsonAtomic } from '../util.ts';
import { runCapture, runLogged, which } from './proc.ts';
import { sshExec } from './ssh.ts';
import type { ExecOptions, ExecSpec, Logger, VmBackend, VmSpec, VmStatus } from './types.ts';

interface FcMeta {
  index: number;
  kind: string;
  createdAt: string;
}

const MAX_VMS = 250;

/**
 * Firecracker microVMs (Linux host with /dev/kvm). Per VM:
 *   rootfs.ext4  copy of the prebuilt image for the agent kind (replaceable)
 *   data.ext4    persistent /home/cage — holds the agent's login, survives image rebuilds
 *   tap cage<N>  172.30.N.0/30 point-to-point link, NAT + firewall set up by scripts/fc-net.sh
 * The guest's cage-init reads IP, gateway and the SSH public key from the kernel command line.
 */
export class FirecrackerBackend implements VmBackend {
  readonly name = 'firecracker';
  readonly isolated = true;
  readonly needsProvision = false;
  private readonly cfg: CageConfig['firecracker'];

  constructor(cfg: CageConfig['firecracker']) {
    this.cfg = cfg;
  }

  private root(): string {
    return join(cageHome(), 'vms');
  }

  private paths(vm: VmSpec) {
    const dir = join(this.root(), vm.name);
    return {
      dir,
      meta: join(dir, 'meta.json'),
      rootfs: join(dir, 'rootfs.ext4'),
      data: join(dir, 'data.ext4'),
      key: join(dir, 'id_ed25519'),
      knownHosts: join(dir, 'known_hosts'),
      config: join(dir, 'firecracker.json'),
      sock: join(dir, 'firecracker.sock'),
      log: join(dir, 'firecracker.log'),
      pid: join(dir, 'firecracker.pid'),
    };
  }

  private meta(vm: VmSpec): FcMeta | undefined {
    return readJson<FcMeta | undefined>(this.paths(vm).meta, undefined);
  }

  net(index: number) {
    const b = this.cfg.subnetBase;
    return { tap: `cage${index}`, host: `${b}.${index}.1`, guest: `${b}.${index}.2`, mac: `06:00:00:00:${index.toString(16).padStart(2, '0')}:02` };
  }

  private allocateIndex(): number {
    const used = new Set<number>();
    if (existsSync(this.root())) {
      for (const d of readdirSync(this.root())) {
        const m = readJson<FcMeta | undefined>(join(this.root(), d, 'meta.json'), undefined);
        if (m) used.add(m.index);
      }
    }
    for (let i = 1; i <= MAX_VMS; i++) if (!used.has(i)) return i;
    throw new Error(`no free VM slots (max ${MAX_VMS})`);
  }

  private livePid(vm: VmSpec): number | undefined {
    const p = this.paths(vm);
    let pid: number;
    try {
      pid = Number(readFileSync(p.pid, 'utf8').trim());
      process.kill(pid, 0);
    } catch {
      return undefined;
    }
    try {
      // Guard against pid reuse after a host reboot.
      if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('firecracker')) return undefined;
    } catch {
      return undefined;
    }
    return pid;
  }

  async status(vm: VmSpec): Promise<VmStatus> {
    if (this.livePid(vm)) return 'running';
    return existsSync(this.paths(vm).rootfs) ? 'stopped' : 'absent';
  }

  async up(vm: VmSpec, log: Logger): Promise<void> {
    const meta = this.meta(vm) ?? (await this.create(vm, log));
    if (this.livePid(vm)) return;
    await this.start(vm, meta, log);
  }

  private async create(vm: VmSpec, log: Logger): Promise<FcMeta> {
    const p = this.paths(vm);
    const base = join(this.cfg.imagesDir, `${vm.agent.kind}.ext4`);
    if (!existsSync(base)) throw new Error(`Missing base image ${base}.\nBuild it (needs Docker): ${join(PKG_ROOT, 'images/build-rootfs.sh')} ${vm.agent.kind}`);
    if (!existsSync(this.cfg.kernel)) throw new Error(`Missing guest kernel ${this.cfg.kernel}.\nFetch it: ${join(PKG_ROOT, 'images/fetch-firecracker.sh')}`);
    mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    const meta: FcMeta = { index: this.allocateIndex(), kind: vm.agent.kind, createdAt: new Date().toISOString() };
    writeJsonAtomic(p.meta, meta); // reserve the index before the slow copies
    try {
      log(`creating ${vm.name}: rootfs from ${base}`);
      await runLogged('cp', ['--sparse=always', '--reflink=auto', base, p.rootfs], log);
      log(`creating ${vm.agent.diskGiB} GiB data disk (persistent home)`);
      await runLogged('truncate', ['-s', `${vm.agent.diskGiB}G`, p.data], log);
      await runLogged(await mkfsExt4(), ['-q', '-F', '-L', 'cagedata', p.data], log);
      await runLogged('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `cage@${vm.name}`, '-f', p.key], log);
      rmSync(p.knownHosts, { force: true });
    } catch (err) {
      rmSync(p.dir, { recursive: true, force: true });
      throw err;
    }
    return meta;
  }

  private async start(vm: VmSpec, meta: FcMeta, log: Logger): Promise<void> {
    const p = this.paths(vm);
    const net = this.net(meta.index);
    if (!existsSync(`/sys/class/net/${net.tap}`)) {
      throw new Error(
        `Network device ${net.tap} is missing. Create it once (needs root; survives until host reboot):\n` +
          `  sudo ${join(PKG_ROOT, 'scripts/fc-net.sh')} up ${meta.index} ${userInfo().username}`,
      );
    }
    const pub = readFileSync(`${p.key}.pub`, 'utf8').trim();
    const bootArgs = [
      'console=ttyS0', 'reboot=k', 'panic=1', 'pci=off', 'net.ifnames=0',
      `cage.ip=${net.guest}/30`, `cage.gw=${net.host}`, `cage.hostname=${vm.name}`,
      `cage.key=${Buffer.from(pub).toString('base64')}`,
    ].join(' ');
    writeJsonAtomic(p.config, {
      'boot-source': { kernel_image_path: this.cfg.kernel, boot_args: bootArgs },
      drives: [
        { drive_id: 'rootfs', path_on_host: p.rootfs, is_root_device: true, is_read_only: false },
        { drive_id: 'data', path_on_host: p.data, is_root_device: false, is_read_only: false },
      ],
      'machine-config': { vcpu_count: vm.agent.cpus, mem_size_mib: vm.agent.memoryMiB, smt: false },
      'network-interfaces': [{ iface_id: 'eth0', guest_mac: net.mac, host_dev_name: net.tap }],
    });
    rmSync(p.sock, { force: true });
    log(`booting ${vm.name} (${net.guest})`);
    const fd = openSync(p.log, 'a');
    const child = spawn(this.cfg.binary, ['--api-sock', p.sock, '--config-file', p.config], { detached: true, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    let spawnError: Error | undefined;
    child.on('error', (e) => (spawnError = e));
    if (!child.pid) throw new Error(`failed to start ${this.cfg.binary}`);
    child.unref();
    writeFileSync(p.pid, String(child.pid));
    await this.waitForSsh(vm, 120_000, () => spawnError);
    log(`${vm.name} is up`);
  }

  private async waitForSsh(vm: VmSpec, timeoutMs: number, spawnError: () => Error | undefined): Promise<void> {
    const p = this.paths(vm);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const err = spawnError();
      if (err) throw new Error(`firecracker failed to start: ${err.message}`);
      if (!this.livePid(vm)) throw new Error(`${vm.name} exited during boot. Last log lines:\n${logTail(p.log)}`);
      const r = await runCapture(await this.exec(vm, 'true'), { timeoutMs: 10_000 }).catch(() => undefined);
      if (r?.exitCode === 0) return;
      await sleep(1000);
    }
    throw new Error(`${vm.name} did not accept SSH within ${timeoutMs / 1000}s. Log: ${p.log}\n${logTail(p.log)}`);
  }

  async down(vm: VmSpec, log: Logger): Promise<void> {
    const pid = this.livePid(vm);
    if (!pid) return;
    const p = this.paths(vm);
    log(`stopping ${vm.name}`);
    // With reboot=k, a guest reboot makes Firecracker exit cleanly (filesystems synced).
    await runCapture(await this.exec(vm, 'sudo -n systemctl reboot || sudo -n reboot'), { timeoutMs: 10_000 }).catch(() => undefined);
    if (!(await waitExit(pid, 20_000))) {
      await fcApi(p.sock, 'PUT', '/actions', { action_type: 'SendCtrlAltDel' }).catch(() => undefined);
      if (!(await waitExit(pid, 10_000))) {
        log(`${vm.name} did not shut down; killing it`);
        process.kill(pid, 'SIGKILL');
        await waitExit(pid, 5_000);
      }
    }
    rmSync(p.pid, { force: true });
    rmSync(p.sock, { force: true });
  }

  async destroy(vm: VmSpec, log: Logger): Promise<void> {
    await this.down(vm, log);
    log(`deleting ${this.paths(vm).dir}`);
    rmSync(this.paths(vm).dir, { recursive: true, force: true });
  }

  async exec(vm: VmSpec, script: string, opts?: ExecOptions): Promise<ExecSpec> {
    const meta = this.meta(vm);
    if (!meta) throw new Error(`VM ${vm.name} does not exist; run \`cage up ${vm.agent.name}\``);
    const p = this.paths(vm);
    const options = [
      '-i', p.key,
      '-o', 'IdentitiesOnly=yes',
      '-o', `UserKnownHostsFile=${p.knownHosts}`,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      ...sshMultiplexOptions(),
    ];
    return sshExec(options, `cage@${this.net(meta.index).guest}`, script, opts);
  }

  async doctor(): Promise<string[]> {
    const problems: string[] = [];
    if (process.platform !== 'linux') return ['Firecracker needs a Linux host with KVM. On macOS use the "lima" backend.'];
    try {
      accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
    } catch {
      problems.push('/dev/kvm is not accessible: enable virtualization and add yourself to the kvm group (`sudo usermod -aG kvm $USER`, then re-login).');
    }
    if (!existsSync(this.cfg.binary) && !(await which(this.cfg.binary))) {
      problems.push(`firecracker binary not found (${this.cfg.binary}). Run ${join(PKG_ROOT, 'images/fetch-firecracker.sh')}`);
    }
    if (!existsSync(this.cfg.kernel)) problems.push(`guest kernel missing (${this.cfg.kernel}). Run ${join(PKG_ROOT, 'images/fetch-firecracker.sh')}`);
    for (const tool of ['ssh', 'ssh-keygen', 'cp', 'truncate']) if (!(await which(tool))) problems.push(`\`${tool}\` not found`);
    try {
      await mkfsExt4();
    } catch (e) {
      problems.push((e as Error).message);
    }
    return problems;
  }

  /** Images missing for these kinds (for doctor/up messages). */
  missingImages(kinds: string[]): string[] {
    return kinds.filter((k) => !existsSync(join(this.cfg.imagesDir, `${k}.ext4`)));
  }
}

/**
 * Reuse one SSH connection per VM (bot latency). The control socket grants command execution in the
 * guest, so it lives in a private 0700 dir, and unix socket paths are capped at 108 bytes, so the
 * dir must be short. Returns no options (plain SSH) when either condition can't be met.
 */
export function sshMultiplexOptions(): string[] {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const dir = join(process.env.XDG_RUNTIME_DIR || tmpdir(), `cage-${uid}`);
  if (dir.length + '/%C'.length - 2 + 40 > 100) return [];
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) return [];
  } catch {
    return [];
  }
  return ['-o', 'ControlMaster=auto', '-o', `ControlPath=${join(dir, '%C')}`, '-o', 'ControlPersist=300'];
}

async function mkfsExt4(): Promise<string> {
  for (const c of ['/usr/sbin/mkfs.ext4', '/sbin/mkfs.ext4']) if (existsSync(c)) return c;
  if (await which('mkfs.ext4')) return 'mkfs.ext4';
  throw new Error('mkfs.ext4 not found (install e2fsprogs)');
}

async function waitExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(250);
  }
  return false;
}

function logTail(path: string, n = 25): string {
  try {
    return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-n).join('\n');
  } catch {
    return '(no log)';
  }
}

function fcApi(socketPath: string, method: string, path: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      { socketPath, method, path, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error('firecracker API timeout')));
    req.on('error', reject);
    req.end(data);
  });
}
