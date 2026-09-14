#!/usr/bin/env python3
"""Summarize a fixed, ordered public-demo block without copying page data."""
import argparse
import collections
import datetime
import json
import math
import statistics


def wilson(successes, n, confidence=0.90):
    z = statistics.NormalDist().inv_cdf((1 + confidence) / 2)
    p = successes / n
    denominator = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denominator
    radius = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    return center - radius, center + radius


def summarize(rows, prefix):
    grouped = collections.defaultdict(list)
    for row in rows:
        trial = row.get('trial') or {}
        if trial.get('id', '').startswith(prefix):
            grouped[trial['id']].append(row)
    trials = []
    for trial_id, observations in grouped.items():
        end = observations[-1]
        trial = end['trial']
        elapsed = datetime.datetime.fromisoformat(end['time'].replace('Z', '+00:00')).timestamp() - trial['started'] / 1000
        trials.append({
            'id': trial_id, 'route': trial['route'],
            'passed': end['checked'] in (True, 'true'), 'rounds': trial['rounds'],
            'expired': any((row.get('command') or {}).get('outcome') == 'expired' for row in observations),
            'try_again_responses': sum(row['action'] == 'verify' and 'try again' in ((row.get('source') or {}).get('text') or '').lower() for row in observations),
            'tile_selections': trial['tileSelections'], 'elapsed_seconds': round(elapsed, 1),
        })
    routes = {}
    for route in sorted({t['route'] for t in trials}):
        arm = [t for t in trials if t['route'] == route]
        routes[route] = {
            'attempts': len(arm), 'passed_within_three': sum(t['passed'] for t in arm),
            'cumulative_passes_at_round_0_1_2_3': [sum(t['passed'] and t['rounds'] <= n for t in arm) for n in range(4)],
            'expirations': sum(t['expired'] for t in arm),
            'try_again_responses': sum(t['try_again_responses'] for t in arm),
            'median_tile_selections': statistics.median(t['tile_selections'] for t in arm),
            'median_elapsed_seconds': round(statistics.median(t['elapsed_seconds'] for t in arm), 2),
        }
    result = {'routes': routes, 'ordered_trials': trials}
    if 'cdp' in routes and 'shared' in routes:
        a, b = routes['shared'], routes['cdp']
        pa, pb = a['passed_within_three'] / a['attempts'], b['passed_within_three'] / b['attempts']
        la, ua = wilson(a['passed_within_three'], a['attempts'])
        lb, ub = wilson(b['passed_within_three'], b['attempts'])
        interval = [pa - pb - math.hypot(pa - la, ub - pb), pa - pb + math.hypot(ua - pa, pb - lb)]
        result['comparison'] = {
            'shared_minus_direct': pa - pb, 'newcombe_90_interval': interval,
            'predeclared_noninferiority_margin': -0.10,
            'lower_bound_above_margin': interval[0] > -0.10,
            'limitation': 'Descriptive independent-binomial interval; repeated trials on one browser/network are dependent and visibly nonstationary. This does not establish distributional equivalence.',
        }
    result['settled_observations'] = sum(1 for observations in grouped.values() for r in observations if (r.get('command') or {}).get('waitMs') != 0)
    result['settled_mismatches'] = [
        {'id': r['trial']['id'], 'seq': r['seq'], 'action': r['action'],
         **{key: r.get(key) for key in ('promptMatch', 'imageMatch', 'geometryMatch')}}
        for observations in grouped.values() for r in observations
        if (r.get('command') or {}).get('waitMs') != 0 and any(r.get(k) is False for k in ('promptMatch', 'imageMatch', 'geometryMatch'))
    ]
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('observations')
    parser.add_argument('--prefix', default='V')
    args = parser.parse_args()
    with open(args.observations) as source:
        print(json.dumps(summarize([json.loads(line) for line in source], args.prefix), indent=2))
