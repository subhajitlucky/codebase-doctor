# Recording script — Codebase Doctor (60 seconds)

Assets in this folder:

| File | What it shows |
| --- | --- |
| `cbd-demo.gif` | `codebase-doctor demo` — disposable fixture: secret, broken import, blast radius, exit 1 |
| `cbd-score.gif` | `scan ... --score --badge` — Repo Health score reveal |
| `screenshot-terminal.png` | 1270×760 terminal: audit findings |
| `screenshot-html-report.png` | 1270×760 standalone HTML report |
| `*.cast` | asciinema sources (trimmed, spinner-free) |

## 60-second screen recording

| Time | Shot | Narration |
| --- | --- | --- |
| 0:00–0:05 | Terminal, big font, dark theme | "Models build. Codebase Doctor verifies." |
| 0:05–0:12 | Type `npx codebase-doctor demo`, run | "One command. No repository, no config — it builds a disposable fixture." |
| 0:12–0:22 | Pause on `[high] security/secrets/provider-token` | "A tracked secret, with evidence and the exact line." |
| 0:22–0:32 | Pause on `[high] source/import-target-missing` | "A broken import the compiler might not catch until runtime." |
| 0:32–0:45 | Pause on `Blast radius` chain `src/config.ts → src/db.ts → src/jobs.ts` | "And what breaks if this file changes — the dependency chain, shortest path, with receipts." |
| 0:45–0:52 | Show `coverage-limitations: ...` and `Exit code 1` | "It never hides what it couldn't check. Exit code 1 is what your CI sees." |
| 0:52–1:00 | Run `audit . --format html > report.html`, open it | "Need to convince a human? One flag gives a shareable report." |

Hook line to open with: **"Your agent writes fast. This catches what it broke."**
Close: **"Models build. Codebase Doctor verifies. npx codebase-doctor demo."**

## Regenerating the GIFs

```bash
# from a neutral directory (npx resolves the local package inside its own repo)
asciinema rec --overwrite --cols 100 --rows 30 --idle-time-limit 1 -q \
  -c 'npx -y codebase-doctor@0.4.2 demo 2>/dev/null | while IFS= read -r line; do printf "%s\n" "$line"; sleep 0.05; done' \
  cbd-demo.cast
agg --font-size 15 --theme asciinema --fps-cap 20 --last-frame-duration 5 \
  cbd-demo.cast cbd-demo.gif
```

Screenshots: render `docs/assets/terminal-preview.svg` centered on `#0f1115`
at 1270×760, and screenshot the `--format html` output in the same window
size.

The demo exits 1 on purpose — that is the CI gate being demonstrated, not a
failure. The fixture directory is removed on exit.
