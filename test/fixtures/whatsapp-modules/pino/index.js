// Stand-in for pino in test/whatsapp.test.mjs: the adapter only hands a silent logger to Baileys.
export default function pino () {
  const logger = { level: 'silent', child: () => logger }
  for (const l of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) logger[l] = () => {}
  return logger
}
