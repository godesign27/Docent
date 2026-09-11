# What Docent can and can't do

*For design-system owners and engineering leads deciding whether to let coding agents use their design system through Docent.*

Docent sits between your design system and the AI coding agents your engineers use (Cursor, Claude Code, Copilot and others). Agents ask Docent which component, token or pattern to use, and whether something is allowed. Docent answers only from your design system as it is in your repository, checks every answer against it, and records every exchange.

## What Docent reads

- **Only what its configuration names**: the component folders, token files, rule documents and docs agreed during onboarding, plus the local files those components import (such as a shared `utils` file), so they can be delivered complete. Nothing else in the repository is read.
- **A read-only copy** of your repository, taken at a specific commit. Docent never pushes, opens pull requests or writes to your repository.
- **Your code is never run.** Components, Tailwind configs and token files are read as text and parsed. Values that could only be known by running code are reported as gaps instead.

## What agents get

Read-only tools, all answered from a snapshot of your design system:

| Tool | What it returns |
|---|---|
| `ask` | Components (props, variants, imports, required nesting, usage rules, accessibility), tokens (values per theme, utilities, meaning), patterns, and governance decisions, including checks on code an agent is about to ship |
| `get_component` | The source of your components and everything they depend on, byte-identical to your repository at the snapshot commit |
| `get_foundation` | The theme and build setup a new project needs to use your components |
| `check_review` | The decision on a request that was sent to a human |

## What Docent guarantees

- **No invented answers.** Components, props, variants, tokens and rules that aren't in your design system are reported as not existing. Agents are told not to build or approximate them. When a name could mean more than one of your components, the agent is asked which one it means.
- **Source wins.** Props, variants and exports come from your component source. Where your documentation or specs disagree, Docent follows the source and reports the disagreement.
- **Every answer is checked before it's returned.** Each component, prop, value, token, pattern and rule in an answer is verified against the snapshot; delivered files are re-hashed. If anything doesn't match, the answer is withheld and the failure is logged.
- **Your rules decide conflicts, with a human where you want one.** Requests and code that break your rules are rejected, sent to a named reviewer, or answered with a warning, according to the severity you give each rule. A request sent for review gets no answer from Docent: the agent is told to wait, and the reviewer's decision and note are what it receives. Asking for an exception always goes to a person unless you choose otherwise.
- **Everything is recorded**: who asked, what they asked (including submitted code), how it was routed and why, what was returned, which checks ran and whether anything was flagged.
- **Your data stays yours.** Each client's snapshot, logs and reviews are kept separately from every other client's, and Docent checks that separation.

## What Docent doesn't do

- **It doesn't design or author.** It won't create components, tokens or patterns, or change your design system.
- **It doesn't use AI to answer.** Questions are routed and answered by deterministic matching against your design system, which is why answers can be verified and repeated. The trade-off: it recognises what requests name and how they're worded, so a badly phrased question may get "which of these do you mean?" instead of an answer.
- **It only enforces rules you've written down**, either in your repository or agreed with you during onboarding and recorded in Docent's configuration with who agreed them. Docent can prove some violations itself: third-party UI libraries, imports outside approved paths, components outside your inventory, invalid prop values, parts outside their required parent, hard-coded colors, re-created components. Rules that need design judgment ("use a modal only for short tasks", "don't use AI styling on human-authored content") are shown to agents but not checked, and each governance answer lists what wasn't evaluated. A rule without a severity can only produce a warning.
- **It can't make an agent listen.** Docent answers agents that ask. An agent can still ignore it or write code without asking. Pair Docent with your normal code review and CI.
- **It's only as current as its last snapshot.** Changes to your design system reach agents after the next ingestion, which is typically part of your release process.
- **Some things are out of reach of static reading**: props inherited from third-party primitives (e.g. Radix) are named but not listed one by one, and framework defaults such as Tailwind's built-in spacing scale aren't part of your design system's contract.

## Your data

| What | Where | Contains |
|---|---|---|
| Snapshot | `contracts/<you>/` on the machine or server running your Docent | The normalized design system and the component files agents may receive |
| Request log | `logs/<you>/requests.jsonl` | Every request and response, including code agents submitted for checking |
| Review queue | `logs/<you>/reviews.jsonl` | Escalated requests and the decisions made on them, append-only |

These are plain files. You decide how long they are kept and who can read them. A deployed Docent is a private container for your design system alone, reachable only over HTTPS with a secret token.

Docent needs read access to the design-system repository. It never asks for, stores or transmits credentials; the machine running it uses whatever git access you grant that machine.

## Human review

When a request conflicts with a rule that needs a person's decision, the agent receives no answer, only a review id, and is told not to proceed. Your reviewers see the request, the code if any, and exactly which rules were involved and why. They approve or deny with a note. The agent checks the review id and follows the note. Every step is logged.

## What we need from you

- Read access to the design-system repository.
- The rules that must block, and how strictly (critical: always reject; high: needs a person; lower: warn). If they aren't written down in the repository, we record the ones you state during onboarding.
- The people who review escalations.
- A handful of real questions your engineers or agents ask, so routing can be tested against how your team actually works.
