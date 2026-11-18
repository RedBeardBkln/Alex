---
description: Run a task through the Planner -> (owner approval) -> Coder -> Tester -> Reviewer -> Security Reviewer pipeline, handling kick-backs automatically.
---

Run the following task through the pipeline defined in `.claude/agents/` (planner, coder, tester, reviewer, security-reviewer). Task: $ARGUMENTS

Steps:

1. Derive a short kebab-case slug from the task for the pipeline folder, e.g. `.claude/pipeline/<slug>/`. Check whether that folder already exists (resuming a task) before creating a new one. When resuming, continue from the first stage whose output file is missing; never start the Coder unless `01a-approval.md` exists.
2. Invoke the `planner` subagent for this task. Wait for it to complete and write `01-plan.md`.
3. **Owner approval (mandatory stop).** Show the user a summary of `01-plan.md` (goal, scope, out of scope, risks/unknowns, acceptance criteria) and its path, then STOP and wait for the user's reply. Do not invoke the `coder` in the same turn.
   - If the user approves: write `.claude/pipeline/<slug>/01a-approval.md` recording the date and the user's exact approval words, then continue to step 4.
   - If the user asks for changes: invoke `planner` again with their feedback, then repeat this step.
   - If the user rejects the plan: stop.
4. Invoke the `coder` subagent. Wait for it to complete and write `02-implementation.md`.
5. Invoke the `tester` subagent. Wait for it to complete and write `03-test-report.md`.
   - If verdict is FAIL: invoke `coder` again (it will read the test report and fix the named issues), then re-invoke `tester`. Repeat until PASS, or until it has failed 3 rounds in a row — in that case stop and summarize the recurring blocker for the user instead of looping indefinitely.
6. Invoke the `reviewer` subagent. Wait for it to complete and write `04-review.md`.
   - If verdict is CHANGES_REQUESTED and routed to `coder`: invoke `coder` again, then re-run from step 5.
   - If verdict is CHANGES_REQUESTED and routed to `planner`: invoke `planner` again with the review findings, then go back to step 3 (the revised plan needs the user's approval again).
   - If verdict is APPROVED: continue to step 7.
7. Invoke the `security-reviewer` subagent. Wait for it to complete and write `05-security-review.md`.
   - If verdict is CHANGES_REQUESTED and routed to `coder`: invoke `coder` again, then re-run from step 5 (tester, reviewer and security-reviewer all run again).
   - If verdict is CHANGES_REQUESTED and routed to `planner`: invoke `planner` again with the findings, then go back to step 3.
   - If verdict is SECURE: continue to step 8.
   - If the reviewer or security-reviewer has sent the work back 3 times in total, stop and summarize the recurring blocker for the user instead of looping.
8. Report a concise summary to the user: what changed, what each agent verified and did not verify, where the pipeline artifacts live, and that it's ready to commit/PR. Do not commit, push, or open a PR automatically — leave that action to the user unless they've explicitly said to.

Do not skip stages and do not let an agent do another agent's job (e.g. don't let the Coder decide it's tested, don't let the Tester approve final review). Each stage's output must actually exist as a file before the next stage starts.
