# Noushi

Noushi is an extensible AI agent that works from your terminal. Give it a goal and a working folder, and it can inspect files, run commands, edit content, and work through multi-step tasks.

Use Noushi for software development, research notes, writing projects, data files, or hobby work. You can use Noushi as is, prompt it to adapt itself to your workflow, or build other applications powered by Noushi using the SDK.

## Start using Noushi

New to Noushi? Follow the [Quickstart](quickstart.md) to install Noushi, connect a model, and complete your first task.

If Noushi is already installed, choose what you want to do:

- [Use Noushi interactively](usage.md) to add files, run commands, direct ongoing work, and export results.
- [Choose a model](models.md) or connect a subscription, API key, local model, or compatible endpoint.
- [Continue or branch a session](sessions.md) to resume work or explore another approach without losing history.
- [Configure Noushi](configuration.md) for your preferences, working folders, instructions, and reusable resources.
- [Understand how Noushi works](how-pi-works.md), including tools, context, sessions, and the agent loop.

## Customize Noushi

Noushi can reuse prompts, load specialized instructions, add executable integrations, change its terminal interface, connect model services, and distribute these resources as packages.
Use the [Quickstart customization chooser](quickstart.md#choose-how-to-customize-pi) to select the smallest mechanism that meets your need.

## Automate or embed Noushi

- Use [print mode](cli.md#invocation-and-output) for one-off and scripted tasks.
- Use [JSON event stream mode](json.md) to consume structured events from one run.
- Use [RPC mode](rpc.md) to control a separate Noushi process.
- Use the [TypeScript SDK](sdk.md) to run Noushi inside an application.

## Find reference and setup information

Use the reference pages to look up [CLI options](cli.md), [settings](settings.md), [providers](providers.md), [keybindings](keybindings.md), and [environment variables](environment-variables.md).

- [Advanced tools](advanced-tools.md) for built-in tools, context controls, and safe tool use.
- [LSP tool](lsp-tool.md) for language-server-backed navigation and diagnostics.

For platform-specific help, see [Terminal Setup](terminal-setup.md), [Windows](windows.md), [tmux](tmux.md), [Termux on Android](termux.md), or [Containerization](containerization.md).

## Work safely

Noushi's tools and extensions run with the permissions of the Noushi process. Project trust controls which project resources Noushi loads, but it does not sandbox tool calls. Review [Security](security.md) before using untrusted files, repositories, extensions, or unattended automation.
