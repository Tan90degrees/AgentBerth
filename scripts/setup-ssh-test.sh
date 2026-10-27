#!/usr/bin/env bash
set -euo pipefail
# Ephemeral loopback server, isolated keys/configuration and a minimal POSIX login Shell; used only by Linux CI.
fixture_dir="$(mktemp -d)"
fixture_user="$(id -un)"
fixture_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
ssh-keygen -q -t ed25519 -N '' -f "$fixture_dir/host_key"
ssh-keygen -q -t ed25519 -N '' -f "$fixture_dir/client_key"
ssh-keygen -q -t ed25519 -N 'fixture-key-passphrase' -f "$fixture_dir/encrypted_client_key"
cat "$fixture_dir/client_key.pub" "$fixture_dir/encrypted_client_key.pub" > "$fixture_dir/authorized_keys"
chmod 755 "$fixture_dir"
chmod 644 "$fixture_dir/authorized_keys"
cat > "$fixture_dir/minimal-shell" <<'MINIMAL'
#!/bin/sh
# Deliberately no command search path: the framework must not invoke Bash,
# multiplexers, base64/tr, Python, Node or a preinstalled helper.
PATH=/nonexistent-agentberth
SHELL=/bin/sh
export PATH SHELL
if [ -n "$SSH_ORIGINAL_COMMAND" ]; then exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"; fi
exec /bin/sh -i
MINIMAL
chmod 755 "$fixture_dir/minimal-shell"
cat > "$fixture_dir/sshd_config" <<CONFIG
ListenAddress 127.0.0.1
Port $fixture_port
HostKey $fixture_dir/host_key
PidFile $fixture_dir/sshd.pid
AuthorizedKeysFile $fixture_dir/authorized_keys
PasswordAuthentication yes
KbdInteractiveAuthentication no
UsePAM yes
StrictModes no
AllowUsers $fixture_user absshfixture
LogLevel VERBOSE
ForceCommand $fixture_dir/minimal-shell
CONFIG
# Disposable CI account verifies actual password authentication without touching runner credentials.
sudo useradd -m -s /bin/sh absshfixture
fixture_password="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
printf '::add-mask::%s\n' "$fixture_password"
printf 'absshfixture:%s\n' "$fixture_password" | sudo chpasswd
sudo mkdir -p /run/sshd
sudo /usr/sbin/sshd -f "$fixture_dir/sshd_config" -E "$fixture_dir/sshd.log"
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
cat >> "$HOME/.ssh/config" <<CONFIG

Host agentberth-ci
  HostName 127.0.0.1
  User $fixture_user
  Port $fixture_port
  IdentityFile $fixture_dir/client_key
  IdentitiesOnly yes
  UserKnownHostsFile $fixture_dir/known_hosts
  StrictHostKeyChecking yes
CONFIG
printf '[127.0.0.1]:%s %s\n' "$fixture_port" "$(cat "$fixture_dir/host_key.pub")" > "$fixture_dir/known_hosts"
ssh -T -o BatchMode=yes agentberth-ci 'case x in x) printf "SSH with POSIX builtins only\n";; esac'
printf 'AGENTBERTH_SSH_TEST_HOST=agentberth-ci\n' >> "$GITHUB_ENV"

printf 'AGENTBERTH_SSH_TEST_PORT=%s\nAGENTBERTH_SSH_TEST_USERNAME=absshfixture\nAGENTBERTH_SSH_TEST_PASSWORD=%s\nAGENTBERTH_SSH_TEST_KEY=%s\n' "$fixture_port" "$fixture_password" "$fixture_dir/encrypted_client_key" >> "$GITHUB_ENV"
