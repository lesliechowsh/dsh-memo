# Security

## Design

dsh-memo is **local-first by construction**:

- It reads only from the DSH `sessionQuery` service (the session corpus DSH
  already stores on the machine) and one JSONL file at
  `$DSH_HOME/memo/notes.jsonl`.
- It makes **no network calls**, sends no data off the machine, and requires
  no API keys or third-party services.
- It does not execute arbitrary code and registers only three model tools
  (`memo_search`, `memo_remember`, `memo_stats`).

## Reporting a vulnerability

If you find a vulnerability — for example in note handling, query escaping,
or anything that could exfiltrate or corrupt session data — please **do not
open a public issue** with exploit details. Report it privately by opening an
issue with the title starting `[security]` and minimal reproduction steps, and
the maintainer will respond and credit you once a fix is published.
