# SSH Remote Execution Contract — Design

Status: design for `/xomp-ssh run`. The metadata store (`SshHostStore`) is delivered; this document fixes the execution contract that `/xomp-ssh run` implements before it registers.

## Threat model

Model text becomes a remote command. A prompt-injected or hallucinated command must not run silently on a user's server. The contract below treats every `/xomp-ssh run` invocation as untrusted input requiring explicit human authorization, matching how the local `bash` tool treats its own consent flow.

## Execution contract

1. **Per-command consent**: every run shows the exact command, target host, and identity path in a `ui.confirm` before spawning `ssh`. No remembered consent, no batch mode. Non-interactive modes (print/JSON) refuse instead of auto-confirming — `ctx.hasUI` must be true.
2. **Allowlist/denylist**: hosts store an optional `allowedCommands` list of exact command prefixes. When set, any command outside the list fails before spawn. Denylist entries (`forbiddenCommands`) always win over the allowlist. Default store behavior with neither list: consent only (no blanket allow).
3. **No shell construction**: the command string is passed to `ssh` as a single argument (`ssh host -- <command>`), never composed through a local shell. Argument splitting is the remote shell's job; we never interpolate model text into flags like `-oProxyCommand`.
4. **Fixed flag set**: the spawn arguments are fully constructed by Noushi: `-p <port>`, `-i <identity>` when stored, `-o BatchMode=yes`, `-o ConnectTimeout=<n>`. Model text can only appear in the command position.
5. **Output caps**: stdout+stderr capped at 256 KiB combined; the process is killed when the cap is exceeded and the result is marked truncated.
6. **Timeout**: default 30s, hard cap 300s. On timeout the process is killed and the error names the timeout, not a generic failure.
7. **Exit-code fidelity**: the result reports exit code, truncated stdout, and truncated stderr separately; a non-zero exit is a structured result, not an exception.
8. **No interactive prompts**: `BatchMode=yes` guarantees password/passphrase prompts fail fast instead of hanging the session. Key-based auth only.
9. **Trust**: requires a trusted project (existing gate) and a stored host alias.

## Command surface

- `/xomp-ssh run <alias> <command>`: resolve alias from `SshHostStore`, apply the contract, spawn the system `ssh`, report the structured result.
- `/xomp-ssh allow <alias> <command-prefix>` / `deny <alias> <command-prefix>`: manage the lists with confirmation.

## Tests (gate)

- Fake-ssh binary (shell script that echoes and exits) exercising: success, non-zero exit, output cap truncation, timeout kill.
- Consent refusal: no spawn occurs (fake-ssh records invocations).
- Allowlist: command outside the list refuses before any process starts; denylist wins over allowlist.
- Non-interactive refusal: `hasUI: false` context fails without spawning.
