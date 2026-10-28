# Aegis for VS Code

Colours and live error checking for [Aegis](https://github.com/) `.aegis` files.

- **Syntax colours** for tools, tests, inputs, permissions, limits, placeholders like `{query}` and `{secret.KEY}`.
- **Live checking.** The same checker as `aegis check` runs while you type. Mistakes are underlined (red for errors, yellow for warnings, blue for info), with the hint in the hover.

## Install

1. Download `aegis-vscode-<version>.vsix` from the Releases page.
2. In VS Code open the Extensions view, click the `...` menu at the top, choose **Install from VSIX...** and pick the file.

Or from a terminal: `code --install-extension aegis-vscode-<version>.vsix`

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `aegis.check.enable` | `true` | Turn the underlining on or off. |
| `aegis.check.delayMs` | `200` | Wait this long after you stop typing before checking. |
