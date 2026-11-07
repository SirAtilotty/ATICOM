# ATICOM

A small, invite-only messenger for a closed group of friends. It runs in the browser and installs on the phone home screen like an app. The server needs nothing but Node.js (22.13 or newer): no other dependencies.

Every installation is independent: its own users, messages, invites and notification keys. It has no connection to anyone else's ATICOM.

## Features

- Private and group chats; add people to a group, leave a group, rename a group
- Photos and voice messages
- Replies (on a phone, swipe a message to the right)
- Read receipts (✓ / ✓✓), "typing…" and "recording…" indicators
- Phone notifications while the app is closed (notifications never contain the message text)
- English and Turkish interface, light and dark theme
- Account deletion

## Running

```sh
npm start        # http://localhost:3000
npm test
```

## Admin commands

```sh
node server.js invite                # creates a one-time invite link (valid for 7 days)
node server.js reset <username>      # creates a temporary password and logs out open sessions
node server.js remove <username>     # removes a member; their old messages stay
node server.js backup <folder>       # backs up the database and files (works while the server is running)
```

Set `BASE_URL=https://yourdomain.com` on the server so links show the right address. Admin command output is in Turkish.

## Language

The app opens in English. Switch to Turkish with the language button on the login screen or in Profile; the choice is remembered in that browser. New interface text goes into `public/i18n.js` in both languages.

## Notifications and sound

Phone notifications only work over HTTPS. The server must be able to reach `fcm.googleapis.com` and `updates.push.services.mozilla.com`. The in-app sound plays only after the user has tapped the screen once after opening the app. Voice recording also requires HTTPS (except on `localhost`).

## Data

Everything lives in the `data/` folder: the database, uploaded photos and voice messages, and the notification key. This folder is excluded from git (`.gitignore`); never share it. Other settings: `PORT` (3000), `HOST` (127.0.0.1), `DATA_DIR`.

## Deployment

Do not expose the server directly to the internet; passwords and messages would travel in plain HTTP. Put a reverse proxy that provides HTTPS in front of it. Example `Caddyfile`:

```
yourdomain.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy already forwards the `Host` and `X-Forwarded-Proto` headers correctly. If you use another proxy, make sure it forwards both: without `Host`, write requests are rejected; without `X-Forwarded-Proto`, the cookie is not marked `Secure`.

## Raspberry Pi setup (no domain or port forwarding needed)

The steps below assume the user `pi` and the project path `/home/pi/ATICOM`; change them if yours differ.

1. Install Node 22.13 or newer. If `node -v` shows an older version:

   ```sh
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt install -y nodejs
   ```

2. Copy the project to the Pi (`git clone`, or the command under "Updating").

3. Open an HTTPS address with Tailscale. This prints your address (`https://<pi>.<tailnet>.ts.net`); your friends do not need to install anything:

   ```sh
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   sudo tailscale funnel --bg 3000
   ```

4. Create `/etc/systemd/system/aticom.service` and put your address on the `BASE_URL` line:

   ```ini
   [Unit]
   Description=ATICOM
   After=network-online.target
   Wants=network-online.target

   [Service]
   User=pi
   WorkingDirectory=/home/pi/ATICOM
   Environment=BASE_URL=https://YOUR-PI.ts.net
   ExecStart=/usr/bin/node server.js
   Restart=always
   NoNewPrivileges=true

   [Install]
   WantedBy=multi-user.target
   ```

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now aticom
   ```

5. Create an invite link:

   ```sh
   cd /home/pi/ATICOM && BASE_URL=https://YOUR-PI.ts.net node server.js invite
   ```

6. If the SD card fails, a backup on the same card is lost with it. Mount a USB stick at `/mnt/usb` and add a daily backup with `crontab -e`. This line skips the backup when the stick is not mounted and deletes backups older than 14 days:

   ```
   0 4 * * * mountpoint -q /mnt/usb && cd /home/pi/ATICOM && node server.js backup /mnt/usb/aticom && find /mnt/usb/aticom -mindepth 1 -maxdepth 1 -mtime +14 -exec rm -rf {} +
   ```

## Updating

Run `npm test` on your computer first. Then send the code to the Pi and restart the service. `data/` is not sent, so messages stay; if the database layout changed, it is updated automatically on startup.

```sh
tar --exclude=data --exclude=.git -czf - -C ~/Desktop ATICOM | ssh pi@PI-ADDRESS 'tar -xzf -' && ssh -t pi@PI-ADDRESS 'sudo systemctl restart aticom'
```

Taking a backup before larger updates is a good idea:

```sh
ssh pi@PI-ADDRESS 'cd ~/ATICOM && rm -rf ~/backup && node server.js backup ~/backup' && scp -r pi@PI-ADDRESS:backup ~/aticom-backup
```

Phones pick up the new version when the app is closed and reopened.
