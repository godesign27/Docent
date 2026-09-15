# Product requirements and intent

Why Docent exists, what it is for, and the decisions that shaped it. Read this before changing Docent, deploying it somewhere new, or building on it. Code and runbooks say *how*; this folder says *why*.

| Document | Answers |
|---|---|
| [`docent-intent.md`](docent-intent.md) | The goal in one page, the principles every change must respect, where the build deliberately differs from the PRD, and where Docent stands against its success metrics. **Start here.** |
| [`docent-prd.md`](docent-prd.md) | The original product requirements: problem, goals, non-goals, users, requirements, metrics, risks. |
| [`uicontext-agent-prd.md`](uicontext-agent-prd.md) | Requirements for the UIContext agent, which drafts `uicontext.md` handoff files and confirms every design-system claim through Docent. |

Related:
- [`../docs/WHAT_DOCENT_DOES.md`](../docs/WHAT_DOCENT_DOES.md): what Docent can and can't do, written for clients.
- [`../docs/IMPLEMENTATION_PLAN.md`](../docs/IMPLEMENTATION_PLAN.md) and [`../uicontext/docs/IMPLEMENTATION_PLAN.md`](../uicontext/docs/IMPLEMENTATION_PLAN.md): how each was built, phase by phase.
- [`../docs/TASKS.md`](../docs/TASKS.md): open work.

## For agents working on or with Docent

1. Read [`docent-intent.md`](docent-intent.md) first, especially **Principles**.
2. If a request would break a principle (for example, answer a question Docent can't confirm, fall back when access is refused, or put a secret in a file), stop and ask the person. Don't find a way around it.
3. When the PRD and the intent document disagree, the intent document records the decision that was actually made, and why.
