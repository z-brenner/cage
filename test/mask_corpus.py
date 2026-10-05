#!/usr/bin/env python3
"""How well the privacy mask (guest/mask.py) finds sensitive values, measured on labeled examples:
  test/fixtures/mask_corpus.json   the main set: add every real-world miss or false alarm here, with its fix
  test/fixtures/mask_holdout.json  written apart from the detectors; never tune them against it
Each case is a text and the sensitive values in it, as [category, value]. A value counts as found when at least 90%
of its letters and digits are masked; a masked span is a false alarm when it touches no labeled value.

Fails if, on the kinds the mask claims by default (emails, phones, cards, IBANs, SSNs, secrets, your terms):
  the main set's recall drops below 0.97 or its precision below 0.98;
  any main-set value is missed that isn't in its "known_misses" (so no single detector can quietly stop working);
  the held-out set's recall drops below 0.92 or its precision below 0.95;
  anything is masked in a main-set case with no labels (the must-keep negatives: dates, versions, order numbers…).
The extra kinds (CAGE_MASK_TYPES) must find 0.9 of their own main-set values without touching a must-keep case.
  python3 test/mask_corpus.py [-v]     (-v lists every miss and false alarm in the main set)
Standard library only; runs on Python 3.9 like the host's `cage mask try`.
"""
import importlib.util, json, os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ["CAGE_MASK_MAP"] = os.path.join(tempfile.mkdtemp(), "map.json")
spec = importlib.util.spec_from_file_location("mask", os.path.join(ROOT, "guest", "mask.py"))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)

CLAIMED = {"EMAIL", "PHONE", "CARD", "IBAN", "SSN", "SECRET", "TERM"}
DEFAULT = set(M.DEFAULT_TYPES.split())
ALL = DEFAULT | set(M.EXTRA_TYPES.split())
VERBOSE = "-v" in sys.argv


def load(name):
    with open(os.path.join(ROOT, "test", "fixtures", name), encoding="utf-8") as f:
        return json.load(f)


def occurrences(text, value):
    out, i = [], text.find(value)
    while i >= 0:
        out.append((i, i + len(value)))
        i = text.find(value, i + 1)
    return out


def score(data, types, categories):
    """recall over labels in `categories`, precision over every masked span; plus the misses and false alarms"""
    terms_re = M.terms_regex(data["terms"])
    found = full = tp = fp = 0
    misses, alarms, negatives = [], [], []
    for case in data["cases"]:
        text, labels = case["text"], case["labels"]
        spans = M.spans(text, terms_re, types)
        covered = [False] * len(text)
        for s, e, _ in spans:
            for k in range(s, e):
                covered[k] = True
        gold = [(cat, v, occurrences(text, v)) for cat, v in labels]
        for cat, v, occ in gold:
            assert occ, "label not in its text: %r in %r" % (v, text)
            if cat not in categories:
                continue
            found += 1
            a, b = occ[0]
            alnum = [k for k in range(a, b) if text[k].isalnum()]
            if sum(covered[k] for k in alnum) >= 0.9 * max(1, len(alnum)):
                full += 1
            else:
                misses.append((cat, v))
        for s, e, kind in spans:
            if any(a < e and s < b for _, _, occ in gold for a, b in occ):
                tp += 1
            else:
                fp += 1
                alarms.append((kind, text[s:e], text))
        if not labels and spans:
            negatives.append((text, [(kind, text[s:e]) for s, e, kind in spans]))
    return full / max(1, found), tp / max(1, tp + fp), found, misses, alarms, negatives


failures = []


def gate(name, data, recall_min, precision_min, details):
    recall, precision, n, misses, alarms, negatives = score(data, DEFAULT, CLAIMED)
    print("%-9s recall %5.1f%% of %d values (gate %.0f%%), precision %5.1f%% (gate %.0f%%)"
          % (name, 100 * recall, n, 100 * recall_min, 100 * precision, 100 * precision_min))
    bad = recall < recall_min or precision < precision_min
    if bad:
        failures.append("%s: recall %.3f, precision %.3f" % (name, recall, precision))
    if details or bad:
        for cat, v in misses:
            print("    missed      [%s] %r" % (cat, v))
        for kind, v, text in alarms:
            print("    false alarm [%s] %r in %r" % (kind, v, text[:100]))
    return negatives


main, holdout = load("mask_corpus.json"), load("mask_holdout.json")
negatives = gate("main", main, 0.97, 0.98, VERBOSE)
known = [tuple(x) for x in main.get("known_misses", [])]
misses = score(main, DEFAULT, CLAIMED)[3]
for cat, v in misses:
    if (cat, v) not in known:
        failures.append("main-set value no longer found: [%s] %r (fix it, or add it to known_misses)" % (cat, v))
for cat, v in known:
    if (cat, v) not in misses:
        failures.append("found now, so take it out of known_misses: [%s] %r" % (cat, v))
gate("held-out", holdout, 0.92, 0.95, False)
keep = sum(1 for c in main["cases"] if not c["labels"])
print("must-keep %d cases with nothing sensitive, %d masked" % (keep, len(negatives)))
for text, what in negatives:
    failures.append("must-keep case masked: %r -> %r" % (text, what))

extra = {c for case in main["cases"] for c, _ in case["labels"]} - CLAIMED - {"AMBIG"}
recall, precision, n, misses, alarms, negatives = score(main, ALL, extra)
print("extra kinds (all on): recall %5.1f%% of %d values (gate 90%%), precision of everything %5.1f%%, must-keep masked %d"
      % (100 * recall, n, 100 * precision, len(negatives)))
if recall < 0.9:
    failures.append("extra kinds: recall %.3f" % recall)
if VERBOSE or recall < 0.9:
    for cat, v in misses:
        print("    missed      [%s] %r" % (cat, v))
for text, what in negatives:
    failures.append("must-keep case masked with the extra kinds on: %r -> %r" % (text, what))

if failures:
    print("FAIL:\n  " + "\n  ".join(failures))
    sys.exit(1)
print("mask corpus: all gates pass")
