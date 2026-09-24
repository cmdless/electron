# @cmdless/ui

Thin CLI entry point for cmdless UI. It doesn't do any UI itself — it caches and runs the actual package that does.

By default, it caches and forwards to [`@cmdless/ui-runtime`](../ui-runtime), matched to the version of `@cmdless/ui-sdk` it was installed with:

```
npx @cmdless/ui show url https://example.com
```

Pass `-p, --package <specifier>` to cache and run a different package instead:

```
npx @cmdless/ui -p some-other-cli@1.2.3 --some-flag
```

Packages are cached under `~/.cmdless` (or `$CMDLESS_ROOT`) on first use and reused on subsequent runs.
