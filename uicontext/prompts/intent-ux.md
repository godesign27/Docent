# Prompt: draft intent-ux.md after design

The lighter-weight prompt the PRD keeps separate from the UIContext agent. Run it once the design is finished and before the UIContext agent, in any agent that can read the repo (Cursor, Claude Code). It records the **why, who and scope** that design settled. The UIContext agent then reads it.

---

You are drafting `{product}_{feature}_{id}_intent-ux.md` for a feature whose design is finished.

## Inputs (read all of them first)

1. The Jira story, e.g. `handoff/jira/{KEY}.md`: problem, acceptance criteria, scope, open questions.
2. The finished prototype: its entry file and whatever it imports from the project itself. Read what it actually does, not what the story hoped for.
3. The template: `intent-ux-template.md`. Keep every section, heading and table in order.

## Rules

- **Evidence only.** Every statement traces to the story, the prototype, or a stated assumption. If neither the story nor the prototype says it, write `UNKNOWN` and add an open question. Never invent metrics, research, names or dates.
- **Label what you infer.** A persona is `assumed` unless research is attached. An experience principle read from the design says "(from the prototype)".
- **Intent, not implementation.** No component names, props, tokens or file paths; those belong in uicontext. Describe capabilities ("the user can read the agent's reasoning"), not widgets ("a dialog").
- **Design versus story.** Where the prototype doesn't cover an acceptance criterion, it isn't designed. Say so under the use case and raise an open question about whether it is in this release. Don't describe a design that doesn't exist.
- **Question priority.**
  - `Blocking`: engineering would have to guess behavior, data or permissions to build it.
  - `Advisory`: it can be built while the question is open.
  - Carry the story's open questions forward with a priority, and add the ones design raised.
- **Status.** `handoff.status` and the Metadata `Status` are `blocked` if any open question is Blocking; otherwise `ready`. Approvals stay `UNKNOWN` / `pending`; only people sign off.
- **Size.** Use the template's size rubric. Fill every section that size requires, and write `none` rather than leaving a required row blank.
- **Illustrative evidence stays labelled.** If the story marks research or figures as samples, the Research table says so, with Low confidence.

## Output

- The file `{product}_{feature}_{id}_intent-ux.md`, next to the story's handoff folder.
- A short note to the requester:
  - how many Blocking and Advisory questions there are
  - which acceptance criteria aren't designed
  - anything in the story the prototype contradicts

Finish by running the template's completeness check and reporting any item that fails.
