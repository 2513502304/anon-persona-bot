# Repository workflow

- Never commit or push directly to `main`. Create a Conventional Commit feature branch and open a pull request.
- Do not bypass branch protection, force-update `main`, or resolve review discussions before addressing their substance.
- Merge approved pull requests using a merge commit only. Never squash or rebase-merge; preserve every layered commit.
- Inspect `git status -sb` before edits and commits. Preserve unrelated changes and stage only owned paths.
- Every commit needs a Conventional Commit subject, a non-empty explanatory body, validation notes, and `Co-authored-by: OpenAI Codex <codex@openai.com>` for Codex-assisted changes.
- Keep credentials, environment files, deployment account configuration and chat data out of Git and logs.
- Run `npm run check`, `npm test`, and `npm run build:daemon` before publishing code changes.
- Review CodeRabbit feedback against the code. Publish tested fixes, reply with evidence, then resolve the corresponding conversations.
- Production deployment does not imply PR approval. Do not replace the production service with an unreviewed change unless the user explicitly authorizes that deployment.

Install local guards with `git config core.hooksPath .githooks`; GitHub protection is the authoritative enforcement layer.
