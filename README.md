# jscpd-scoped

Stateless duplicate-code gates for full repositories and pull requests.

`jscpd-scoped` always runs a fresh [jscpd](https://github.com/kucherenko/jscpd) scan. It adds two enforcement policies without adding cache, baseline, suppression, or session state:

- `full` fails when any duplicate is found.
- `pr` scans the full configured scope but fails only when a duplicate endpoint overlaps a line changed between an explicit base commit and `HEAD`.

## Install

Pin the version in repositories that use it as a CI gate:

```sh
npm install --save-dev --save-exact jscpd-scoped@0.1.0
```

Node 18 or newer is required.

## Usage

```sh
npx jscpd-scoped full src
npx jscpd-scoped pr --base "$BASE_SHA" src
```

Paths default to `.`. PR mode evaluates committed `<base>...HEAD` history and requires a clean worktree. CI must check out enough history for the base commit to be reachable; for GitHub Actions, use `fetch-depth: 0`.

Exit codes are stable:

- `0`: the selected policy passed.
- `1`: duplicate-code violations were found.
- `2`: arguments, Git history, jscpd execution, or report processing failed.

## Configuration

Use jscpd's native `.jscpd.json` for detector settings. The wrapper owns enforcement, so jscpd's global percentage threshold does not decide the result.

```json
{
  "minLines": 5,
  "minTokens": 50,
  "formats": ["javascript", "typescript"],
  "ignore": ["**/generated/**"]
}
```

## GitHub Actions

```yaml
- uses: actions/checkout@v6
  with:
    fetch-depth: 0
- uses: actions/setup-node@v6
  with:
    node-version-file: .nvmrc
    cache: npm
- run: npm ci
- run: npm run duplicates:pr -- "${{ github.event.pull_request.base.sha }}" src
```

```json
{
  "scripts": {
    "duplicates:full": "jscpd-scoped full src",
    "duplicates:pr": "jscpd-scoped pr --base"
  }
}
```

## Reporting bugs

[Search existing issues](https://github.com/zero-stroke/jscpd-scoped/issues) before reporting a defect. Include the package, Node, and jscpd versions; the mode and sanitized command; expected and actual output/exit status; and a minimal synthetic repository when possible.

Never upload proprietary source, credentials, tokens, or secrets. This package performs no telemetry or source upload.

## License

MIT
