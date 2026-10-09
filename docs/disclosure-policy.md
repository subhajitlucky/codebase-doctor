# Disclosure policy for ecosystem studies

Codebase Doctor's ecosystem studies audit **public repositories** with the
offline pipeline. They never execute repository code, never use repository
credentials, and never contact anything the repository owns.

## What we publish

- **Aggregate, anonymized statistics only.** Percentages, counts, and rule
  breakdowns across the sample.
- **No repository names, owners, or links.** A finding that would identify a
  specific project is not published unless the maintainers explicitly agree.
- **Methodology and limitations.** Sample construction, tool version, exact
  commands, and what static analysis cannot prove.

## What we do not do

- No code execution, no `--run-checks`, no network calls beyond fetching the
  public repository content being analyzed.
- No individual notifications built on unnamed findings. If a study ever
  surfaces something that appears to be a live credential or an exploitable
  exposure, we stop and handle it through coordinated disclosure first:
  contact the maintainers privately, wait for a fix or a documented decision,
  and only then decide whether any aggregate statement is still warranted.

## Limitations we state up front

- Static analysis proves patterns in source, not runtime behavior.
- Studies that use shallow clones cannot scan full commit history; that
  limitation is stated per study.
- Samples are convenience samples (for example, "repositories returned by a
  GitHub search"), not random samples. We say so.

## Corrections

If you maintain a project and believe a published aggregate is wrong or
misleading, open an issue or email **subhajitpradhan310@gmail.com**. We will
correct or retract promptly.
