# Zeroshot 2 parity matrix

## 9. Intentional replacements

| Node behavior | Native Rust status | Replacement contract | Authority |
| --- | --- | --- | --- |
| Docker isolation implicitly mounts the user's home directory, Docker socket, and broad host paths | `replaced` | Durable Docker workspace leases mount only deterministic handles beneath the native product's Docker root; home, the Docker socket, filesystem roots, and broad host paths are denied by default. This is an intentional security-breaking replacement, not Node-compatible behavior. | #677 |
