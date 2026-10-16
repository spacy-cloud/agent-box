## Summary

<!-- What does this change and why? Link related issues: Fixes #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactoring / chore
- [ ] Documentation
- [ ] Security-relevant change (hardening, policy, approvals, paths, secrets, network)

## Checklist

- [ ] `pnpm build`, `pnpm test` and `pnpm lint` pass locally
- [ ] `pnpm test:docker` passes (if a container backend or the proxy is affected)
- [ ] Tests added or updated
- [ ] Docs and `CHANGELOG.md` (Unreleased) updated for user-visible changes
- [ ] Logic lives in the core; the surface I touched stays thin
- [ ] No security default was weakened (or the change is explained below, with tests)
- [ ] No personal data in code, tests or examples (use placeholders such as `example.org`)
- [ ] Commit messages follow Conventional Commits

## Security impact

<!-- Does this change what a sandbox or agent can access? If not, write "none". -->
