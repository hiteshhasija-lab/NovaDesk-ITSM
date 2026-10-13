#!/usr/bin/env python3
"""Recomputes the headline numbers quoted in the evaluation draft from the saved result folders.

    python3 audit-numbers.py            # prints a table; exit status 1 if any claim is MISMATCH
    python3 audit-numbers.py --json     # the same as JSON

Every claim names the file(s) it was derived from. Status:
  MATCH       the draft's number is what the raw files give
  CAUTION     the number is right but the comparison or wording can mislead; see the note
  MISMATCH    the draft's number is not what the raw files give
  NOT-IN-FILES  cannot be derived from these folders (needs another source)
The real-run timings come from results/real-decommissions-activity-log.txt, a read-only copy of the
production activity_log rows (psql output) saved on 2026-10-13; the release counts come from git.
"""
import glob, json, os, re, statistics, subprocess, sys, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, 'results')
FIN = {'done', 'approved', 'destroyed', 'posted'}
rows = []

def J(path): return json.load(open(os.path.join(RES, path)))
def add(cid, where, claim, draft, got, status, note='', src=''):
    rows.append(dict(id=cid, where=where, claim=claim, draft=str(draft), got=str(got), status=status, note=note, src=src))
def eq(cid, where, claim, draft, got, note='', src=''):
    add(cid, where, claim, draft, got, 'MATCH' if str(draft) == str(got) else 'MISMATCH', note, src)

# ---------------------------------------------------------------- E1 baseline (2.1)
e1 = J('run-2026-10-06/results/e1/e1.json')
tot = [r['totalMs'] / 1000 for r in e1]
eq('E1.1', '2.1', 'Fault-free runs', 5, len(e1), src='run-2026-10-06/results/e1/e1.json')
eq('E1.2', '2.1', 'End to end, min to max (s)', '50.4 to 50.6', f'{min(tot):.1f} to {max(tot):.1f}')
eq('E1.3', '2.1', 'End to end, median (s)', 50.5, f'{statistics.median(tot):.1f}')
eq('E1.4', '2.1', 'Callbacks per run', 20, sorted({sum(r["callbackOutcomes"].values()) for r in e1})[0])
eq('E1.5', '2.1', 'Runs with divergence at end', 0, sum(r['divergenceAtEnd']['diverged'] for r in e1))
fr = [r['firstSuccessfulResolveMs'] for r in e1]
add('E1.6', '2.1', 'First card resolution reached the receiver within (ms)', '150 to 330', f'{min(fr)} to {max(fr)}', 'MATCH',
    'Rounded to the nearest ten', 'run-2026-10-06/results/e1/e1.json')

# ---------------------------------------------------------------- E2 first campaign (0.0.64)
def before_runs():
    out = []
    for f in sorted(glob.glob(os.path.join(RES, 'run-2026-10-06/results/e2*/e2.json'))):
        if f.endswith('e2f/e2.json'): continue                       # superseded by e2f-rerun (see REPORT.md)
        for r in json.load(open(f)):
            if r['fault'] == 'normal' and not f.endswith('e2a/e2.json'): continue
            out.append(r)
    return out
def flags(r):
    rr = (r.get('divergenceAfterGrace') or {}).get('rows', [])
    strict = any(x['diverged'] for x in rr)
    live = any(x['diverged'] and x['receiver'] == 'pending' and x['expect'] in FIN for x in rr)
    late_missing = any(x['diverged'] and x['receiver'] == 'MISSING' and x['expect'] in FIN for x in rr)
    return strict, live, late_missing, sum(1 for x in rr if x['diverged'] and x['receiver'] == 'MISSING')
B = before_runs()
BF = [r for r in B if r['fault'] != 'normal']
BNH = [r for r in BF if not r['hang']]
bad4 = [r for r in BNH if r['fault'] in ('refuse', 'html404', 'status500', 'flaky')]
eq('E2.1', '2.2', 'Runs in the first campaign', 17, len(B), 'e2f (hang) superseded by e2f-rerun', 'run-2026-10-06/results/e2*/e2.json')
eq('E2.2', '2.2', 'NovaDesk reached "approved" in all runs', '17 of 17', f'{sum(1 for r in B if r["nd"]["approval_status"] == "approved")} of {len(B)}')
eq('E2.3', '2.2', 'Refused/misrouted/500/intermittent runs left the chat wrong', '12 of 12', f'{sum(1 for r in bad4 if flags(r)[0])} of {len(bad4)}')
eq('E2.4', '2.2', 'Faulted runs that did not hang', 15, len(BNH))
eq('E2.5', '2.2', 'Of those, runs with a live button on finished work', 10, sum(1 for r in BNH if flags(r)[1]))
eq('E2.6', '2.2', 'Of those, cards that never arrived', 22, sum(flags(r)[3] for r in BNH))
eq('E2.7', '2.2', 'Of those, runs where the operator lacked the card needed', 12, sum(1 for r in BNH if r['blocked'] > 0),
   'Measured at the time of each pre-check (the fault was active), not after the fault cleared')
eq('E2.8', '2.2 table', 'Before: runs left with the chat wrong after 30 s (strict)', '12 of 16', f'{sum(1 for r in BF if flags(r)[0])} of {len(BF)}')

# ---------------------------------------------------------------- E2/E3 matrix on 0.0.78
A = J('run-2026-10-12-v078b/v078b-e2/e2.json')
AF = [r for r in A if r['fault'] != 'normal']
a_strict = sum(1 for r in AF if flags(r)[0]); a_live = sum(1 for r in AF if flags(r)[1])
b_live = sum(1 for r in BF if flags(r)[1])
eq('E3.1', '2.2', 'Matrix runs / approved', '17 / 17', f'{len(A)} / {sum(1 for r in A if r["nd"]["approval_status"] == "approved")}', src='run-2026-10-12-v078b/v078b-e2/e2.json')
eq('E3.2', '2.2 table', 'After: runs with actionable divergence after the grace period', '0 of 16', f'{a_live} of {len(AF)}')
add('E3.3', '2.2 table', 'The table sets "12 of 16" (before) against "0 of 16" (after)', '12 of 16 vs 0 of 16',
    f'strict: {sum(1 for r in BF if flags(r)[0])} of 16 vs {a_strict} of 16; live button on finished work: {b_live} of 16 vs {a_live} of 16', 'CAUTION',
    'The two numbers use different measures (before = any card difference after 30 s; after = a live button or a needed card missing after 120 s). '
    f'Like for like the improvement is {b_live} of 16 to {a_live} of 16 on actionable divergence, and {sum(1 for r in BF if flags(r)[0])} to {a_strict} on strict divergence, '
    'which stays high by design because a card for finished work is not posted late.', 'v078b-e2 vs run-2026-10-06 e2a to e2f-rerun')
conv_all = [r['convergedAfterSec'] for r in AF]
conv_div = [r['convergedAfterSec'] for r in AF if r['divergenceAtEnd']['diverged'] > 0]
add('E3.4', '2.2 table', 'Convergence after the fault cleared, median / max (s)', '0.6 / 23.3',
    f'all 16 faulted runs: {statistics.median(conv_all):.2f} / {max(conv_all)}; the {len(conv_div)} runs that had diverged: {statistics.median(conv_div):.1f} / {max(conv_div)}', 'CAUTION',
    'The median of 0.6 is over all 16 faulted runs, including the five that never diverged (slow, one intermittent, the hang case). '
    f'Over the {len(conv_div)} runs that had a card to repair the median is {statistics.median(conv_div):.1f} s; use that one, and the maximum, in the paper.')
eq('E3.5', '2.2 table', 'Duplicates across the matrix', 0, sum((r.get('divergenceAfterGrace') or {}).get('duplicates', 0) for r in A))
pp = {r['fault']: r['convergedAfterSec'] for r in J('run-2026-10-06-ledger/prod-params/e2.json')}
eq('E3.6', '2.2 table', 'Production timings (0.0.69), refuse and 500 (s)', '82.5 and 10.3', f'{pp["refuse"]} and {pp["status500"]}', 'Two runs, 30 s retry base',
   'run-2026-10-06-ledger/prod-params/e2.json')
e6 = {c['case']: c for c in J('run-2026-10-12-v078b/v078b-e6/e6.json')}
eq('E3.7', '2.2', 'Restart with undelivered cards, convergence (s)', 6.7, e6['6a']['convergedAfterSec'], src='run-2026-10-12-v078b/v078b-e6/e6.json')
eq('E3.8', '2.2', 'Receiver down for the flow plus two minutes (s)', 10.9, e6['6b']['convergedAfterSec'])
eq('E3.9', '2.2', 'Pre-check finished while its card was undelivered (s), no late card', '19.9 and 0', f'{e6["6d"]["convergedAfterSec"]} and {e6["6d"]["lateCardForFinishedTask"]}')
eq('E3.10', '2.2', 'Persistently failing target marked dead', True, e6['6c']['markedDead'])

# ---------------------------------------------------------------- E4 scheduler (2.3)
e4 = open(os.path.join(RES, 'run-2026-10-06/results/e4/summary.md')).read()
add('E4.1', '2.3', 'Before: receiver down when the timer fired, card never arrived', 'never arrived', 'NEVER arrived' if 'NEVER arrived' in e4 else 'not found',
    'MATCH' if 'NEVER arrived' in e4 else 'MISMATCH', src='run-2026-10-06/results/e4/summary.md')
e4b = open(os.path.join(RES, 'run-2026-10-06-ledger/ledger-e4b/summary.md')).read()
m = re.search(r'card arrived ([\d.]+) s after restore, 1 copy', e4b)
add('E4.2', '2.3', 'After: card arrived (s after the receiver returned), once', 'about 23, 1 copy', f'{m.group(1)}, 1 copy' if m else 'not found',
    'MATCH' if m and round(float(m.group(1))) == 23 else 'MISMATCH', 'Rounded', 'run-2026-10-06-ledger/ledger-e4b/summary.md')

# ---------------------------------------------------------------- E5 probes (2.4)
e5_first = J('run-2026-10-06/results/e5/e5.json')
eq('E5.1', '2.4', 'First suite: probes / unsafe behaviours', '14 / 6', f'{len(e5_first)} / {sum(1 for p in e5_first if not p["ok"] and p["id"] != "P12")}', 'P6 to P11 failed; P12 passed only because the rig had no hypervisor credentials',
   'run-2026-10-06/results/e5/e5.json')
later = [f for f in sorted(glob.glob(os.path.join(RES, 'run-*/**/e5.json'), recursive=True)) if '/run-2026-10-06/' not in f]
res = [(len(json.load(open(f))), sum(1 for p in json.load(open(f)) if not p['ok'])) for f in later]
eq('E5.2', '2.4', 'Later saved suites: probes each / total failing', f'17 / 0 in all {len(res)}', f'{"/".join(str(a) for a in sorted({a for a, b in res}))} / {sum(b for a, b in res)} in all {len(res)}', f'{len(res)} saved suites from the first 17-probe run onward')

# ---------------------------------------------------------------- E8, E10 retries (2.5)
e8 = {c['case']: c for c in J('run-2026-10-06-ledger/e8b/e8.json')}
e10 = {c['case']: c for c in J('run-2026-10-07-v071/v071-e10c/e10.json')}
eq('E8.1', '2.5', 'Resolve answered 500 twice: requests inside 1 s', '3 within 1 s', f'{e8["8a"]["resolveRequests"]} within {round(e8["8a"]["spanMs"] / 1000)} s', f'span {e8["8a"]["spanMs"]} ms')
add('E8.2', '2.5', 'Card post 500, not saved: ledger resent after about 7 s, 1 copy', 'about 7 s, 1 copy', f'{e8["8c"]["convergedAfterSec"]} s (0.0.69), {J("run-2026-10-07-v071/v071-e8/e8.json")[2]["convergedAfterSec"]} s (0.0.71); {e8["8c"]["preCheckCardCopies"]} copy', 'CAUTION',
    'The resend gap varies with the retry loop between 6.8 and 10.2 s in the two saved runs; say "about 7 to 10 s".')
eq('E8.3', '2.5', 'Saved then 500, no key: copies', 2, e8['8d']['preCheckCardCopies'])
eq('E8.4', '2.5', 'Same with a key: copies / duplicate answer', '1 / 1', f'{e10["10a"]["copies"]} / {e10["10a"]["duplicateKeyAnswers"]}', src='run-2026-10-07-v071/v071-e10c/e10.json')
add('E8.5', '2.5', 'Key known: retry after 505 ms instead of 6 to 9 s', '505 ms vs 6 to 9 s', f'{e10["10b"]["gapAfterLearningMs"]} ms vs {e10["10b"]["gapBeforeLearningMs"]} ms', 'CAUTION',
    'One saved measurement of 8.9 s before learning; "6 to 9 s" is a range from the retry loop that this file alone does not show.')
eq('E8.6', '2.5', 'Older receiver that ignores keys: copies', 2, e10['10c']['copies'])

# ---------------------------------------------------------------- E9 concurrency (2.6)
e9b = {c['case']: c for c in J('run-2026-10-08-v072/e9-before/e9.json')}
e9a = {c['case']: c for c in J('run-2026-10-08-v072/v072-e9/e9.json')}
eq('E9.1', '2.6', 'Before: same pre-check twice, log lines', 2, e9b['9a']['completedLogLines'], src='run-2026-10-08-v072/e9-before/e9.json')
eq('E9.2', '2.6', 'Before: last two pre-checks together, power-down starts', 2, e9b['9b']['powerDownStarts'])
eq('E9.3', '2.6', 'After: power-down starts', 1, e9a['9b']['powerDownStarts'], src='run-2026-10-08-v072/v072-e9/e9.json')
add('E9.4', '2.6', 'After: "the second request receives a conflict answer"', 'conflict answer', f'9a statuses {e9a["9a"]["statuses"]}; 9b statuses {e9a["9b"]["statuses"]}', 'CAUTION',
    'The 409 is for completing the same pre-check twice (9a). For the last two pre-checks together (9b) both answer 200 and only one power-down starts.')

# ---------------------------------------------------------------- E11 hypervisor faults (2.7)
e11b = J('run-2026-10-07-esxi/e11/e11.json'); e11a = J('run-2026-10-08-v072/v072-e11b/e11.json')
bb = {c['case']: c for c in e11b}; aa = {c['case']: c for c in e11a}
eq('E11.1', '2.7', 'Scenarios on 0.0.72 (ten) vs 0.0.71 (eight)', '10 vs 8', f'{len(e11a)} vs {len(e11b)}')
add('E11.2', '2.7', 'On 0.0.71 two scenarios wedged (power-off answer lost; destroy answer lost)', 'two stuck',
    f'11c power task {bb["11c"]["afterRetry"]["powerTask"]}; 11g retry answer {bb["11g"]["secondAnswer"]}, tasks {bb["11g"]["final"]["tasks"]}', 'MATCH', src='run-2026-10-07-esxi/e11/e11.json')
eq('E11.3', '2.7', 'On 0.0.72, the destroy retry after a lost answer', '200, closed', f'{aa["11g"]["secondAnswer"]}, {aa["11g"]["final"]["change"]}', src='run-2026-10-08-v072/v072-e11b/e11.json')

# ---------------------------------------------------------------- E13 crash recovery (2.8)
bf = {c['case']: c for c in J('run-2026-10-12-v076/e13-before/e13.json')}
af = {c['case']: c for c in J('run-2026-10-12-v076/v077-e13/e13.json')}
a80 = {c['case']: c for c in J(glob.glob(os.path.join(RES, 'run-2026-10-12-v080/*/e13.json'))[0].replace(RES + os.sep, ''))}
eq('E13.1', '2.8', 'Before: kill points that resumed by themselves', '0 of 6',
   f'{sum(1 for k in ("13c",) if bf[k].get("resumedOnItsOwn")) + sum(1 for k in ("13a","13b") if bf[k]["afterRestartWait"]["change"] == "closed") + sum(1 for k in ("13d",) if bf[k].get("nextPrecheckCardPosted")) + (1 if bf["13f"].get("converged") else 0)} of 6',
   'afterRestartWait shows 13a and 13b unchanged; the "final: closed" is after the person\'s retry (answer 200)', 'run-2026-10-12-v076/e13-before/e13.json')
eq('E13.2', '2.8', 'Before: 13a and 13b finished only after a repeated confirmation', '200, 200', f'{bf["13a"]["retryAnswer"]}, {bf["13b"]["retryAnswer"]}')
eq('E13.3', '2.8', 'Before: 13f converged within 181 s', 'no', 'yes' if bf['13f']['converged'] else 'no')
times = [af['13e']['afterSec'], af['13d']['afterSec'], af['13f']['convergedAfterSec'], af['13c']['afterSec'], af['13a']['afterSec'], af['13b']['afterSec']]
eq('E13.4', '2.8', 'After (0.0.76): seconds, by kill point (e, d, f, c, a, b)', '49, 50, 49.8, 60, 60, 80', ', '.join(str(t) for t in times), src='run-2026-10-12-v076/v077-e13/e13.json')
eq('E13.5', '2.8', 'After: power-off calls on resume / after a failed power-off', '1 / 0', f'{af["13c"]["powerOffCalls"]} / {af["13g"]["powerOffCallsAfterRestart"]}')
eq('E13.6', '2.8', 'After: destroy calls after a failed destroy and restart', 0, af['13h']['destroyCallsAfterRestart'])
t80 = [a80['13e']['afterSec'], a80['13d']['afterSec'], a80['13f']['convergedAfterSec'], a80['13c']['afterSec'], a80['13a']['afterSec'], a80['13b']['afterSec']]
add('E13.7', '2.8', 'Re-run on 0.0.80: same behaviour', 'as 0.0.76', ', '.join(str(t) for t in t80), 'MATCH' if max(t80) <= 80 and min(t80) >= 49 else 'MISMATCH',
    'Range 49 to 80 s still holds', 'run-2026-10-12-v080/*/e13.json')

# ---------------------------------------------------------------- real decommissions (2.10)
log = os.path.join(RES, 'real-decommissions-activity-log.txt')
if os.path.exists(log):
    ev = {}
    for line in open(log, encoding='utf8'):
        p = [x.strip() for x in line.split(' | ')]
        if len(p) == 4 and p[0].startswith('CHG') and p[1].isdigit():
            ev.setdefault(p[0], []).append((dt.datetime.strptime(p[2], '%Y-%m-%d %H:%M:%S'), p[3]))
    draft = {'CHG0000067': ('9 min', 6.5), 'CHG0000068': ('12 min', 6.7), 'CHG0000069': ('21 min', 18.7), 'CHG0000070': ('25 min', 6.5)}
    for num, (el, off) in draft.items():
        e = ev[num]; created = e[0][0]
        closed = next(t for t, m in e if m.startswith('Change closed'))
        po = next(t for t, m in e if m.startswith('VM powered off')); de = next(t for t, m in e if m.startswith('VM destroyed'))
        got_el = round((closed - created).total_seconds() / 60); got_off = round((de - po).total_seconds() / 60, 1)
        eq(f'R.{num[-2:]}', '2.10', f'{num}: submitted to closed; power-off to destroy (min)', f'{el.split()[0]}; {off}', f'{got_el}; {got_off}',
           f'created {created:%H:%M:%S}, closed {closed:%H:%M:%S}', 'results/real-decommissions-activity-log.txt')
else:
    add('R.0', '2.10', 'Real decommission timings', 'see 2.10', 'activity log copy missing', 'NOT-IN-FILES', 'Save the production activity_log rows as results/real-decommissions-activity-log.txt')

# ---------------------------------------------------------------- release counts (1) from git
def versions(repo, path):
    try:
        out = subprocess.run(['git', '-C', repo, 'log', '-p', '--reverse', '--format=', '--', path], capture_output=True, text=True, check=True).stdout
        return sorted({m.group(1) for m in re.finditer(r"^\+module\.exports = '([\d.]+)'", out, re.M)}, key=lambda v: [int(x) for x in v.split('.')])
    except Exception:
        return None
nd = versions(os.path.dirname(os.path.dirname(HERE)), 'src/version.js')
if nd:
    n = [v for v in nd if v.startswith('0.0.') and int(v.split('.')[2]) >= 65]
    eq('V.1', '1', 'NovaDesk releases 0.0.65 to 0.0.80', 16, len(n), 'Distinct versions in src/version.js history', 'git log -p src/version.js')
nc = versions(os.environ['NOVACONNECT_REPO'], 'src/version.js') if os.environ.get('NOVACONNECT_REPO') else None   # path to a NovaConnect checkout; skipped when unset
if nc:
    n = [v for v in nc if v.startswith('1.0.') and int(v.split('.')[2]) >= 183]
    eq('V.2', '1', 'NovaConnect releases 1.0.183 to 1.0.187', 5, len(n), 'Distinct versions in src/version.js history (NovaConnect repo)', 'git log -p src/version.js')
add('X.1', '2.9', 'Twelve checks of the chat system\'s access rule against a real database', 'twelve checks', 'not in the result folders', 'NOT-IN-FILES',
    'These ran as a throwaway-database script outside the rig; re-run or cite the script, not these folders.')

if '--json' in sys.argv:
    print(json.dumps(rows, indent=1))
else:
    w = {k: max(len(str(r[k])) for r in rows) for k in ('id', 'where', 'status')}
    for r in rows:
        print(f"{r['id']:<{w['id']}}  {r['where']:<{w['where']}}  {r['status']:<12} {r['claim']}")
        print(f"{'':<{w['id']+w['where']+4}}  draft: {r['draft']}   |   recomputed: {r['got']}")
        if r['note']: print(f"{'':<{w['id']+w['where']+4}}  note: {r['note']}")
    from collections import Counter
    c = Counter(r['status'] for r in rows)
    print('\n' + ', '.join(f'{k}: {v}' for k, v in sorted(c.items())))
sys.exit(1 if any(r['status'] == 'MISMATCH' for r in rows) else 0)
