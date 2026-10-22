#!/usr/bin/env bash
set -euo pipefail
# Ephemeral loopback server, isolated keys/configuration; used only by Linux CI.
fixture_dir="$(mktemp -d)"
fixture_user="$(id -un)"
fixture_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
ssh-keygen -q -t ed25519 -N '' -f "$fixture_dir/host_key"
ssh-keygen -q -t ed25519 -N '' -f "$fixture_dir/client_key"
cp "$fixture_dir/client_key.pub" "$fixture_dir/authorized_keys"
chmod 755 "$fixture_dir"
chmod 644 "$fixture_dir/authorized_keys"
cat > "$fixture_dir/sshd_config" <<CONFIG
ListenAddress 127.0.0.1
Port $fixture_port
HostKey $fixture_dir/host_key
PidFile $fixture_dir/sshd.pid
AuthorizedKeysFile $fixture_dir/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
StrictModes no
AllowUsers $fixture_user
LogLevel VERBOSE
CONFIG
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
ssh -T -o BatchMode=yes agentberth-ci 'command -v tmux && command -v bash'
printf 'AGENTBERTH_SSH_TEST_HOST=agentberth-ci\n' >> "$GITHUB_ENV"
