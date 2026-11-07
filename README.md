# ATICOM

A small, invite-only messenger for a closed group of friends. It runs in the browser, installs on the phone home screen, and needs nothing but Node.js (22.13+) on the server — no other dependencies. Every installation is independent: its own users, messages, invites and notification keys. The interface is in English and Turkish; the documentation below is in Turkish.

---

Kapalı arkadaş grupları için davetle çalışan mesajlaşma uygulaması. Tarayıcıda çalışır, telefonda ana ekrana uygulama gibi yüklenir. Sunucuda Node.js (22.13 veya üstü) dışında hiçbir şey gerekmez.

Her kurulum bağımsızdır: kendi kullanıcıları, mesajları, davetleri ve bildirim anahtarı olur. Başkasının kurduğu ATICOM ile bağlantısı yoktur.

## Özellikler

- Özel ve grup sohbetleri; gruba kişi ekleme, gruptan çıkma, grup adını değiştirme
- Fotoğraf ve sesli mesaj
- Mesaja yanıt verme (telefonda mesajı sağa kaydır)
- Okundu bilgisi (✓ / ✓✓), "yazıyor…" ve "ses kaydediyor…" göstergesi
- Uygulama kapalıyken telefon bildirimi (bildirimde mesaj içeriği yer almaz)
- İngilizce ve Türkçe arayüz, açık ve koyu tema
- Hesap silme

## Çalıştırma

```sh
npm start        # http://localhost:3000
npm test
```

## Yönetim komutları

```sh
node server.js invite                # tek kullanımlık davet linki üretir (7 gün geçerli)
node server.js reset <kullanıcı>     # geçici şifre üretir, açık oturumları kapatır
node server.js remove <kullanıcı>    # üyeyi çıkarır; eski mesajları kalır
node server.js backup <klasör>       # veritabanı ve dosyaları yedekler (sunucu çalışırken de olur)
```

Linklerin doğru adresi göstermesi için sunucuda `BASE_URL=https://alanadin.com` ayarla.

## Dil

Uygulama İngilizce açılır. Giriş ekranındaki dil düğmesinden veya Profil'den Türkçeye geçilir; seçim o tarayıcıda hatırlanır. Yeni metinler `public/i18n.js` dosyasına her iki dilde eklenir. Yönetici komutlarının çıktısı Türkçedir.

## Bildirim ve ses

Telefon bildirimi yalnızca HTTPS adresinde çalışır. Sunucunun `fcm.googleapis.com` ve `updates.push.services.mozilla.com` adreslerine çıkabilmesi gerekir. Uygulama içi ses için kullanıcının açılıştan sonra ekrana bir kez dokunmuş olması gerekir. Sesli mesaj kaydı da HTTPS ister (`localhost` hariç).

## Veriler

Her şey `data/` klasöründe durur: veritabanı, yüklenen fotoğraf ve sesler, bildirim anahtarı. Bu klasör git'e girmez (`.gitignore`); kodu paylaşırken asla bu klasörü paylaşma. Diğer ayarlar: `PORT` (3000), `HOST` (127.0.0.1), `DATA_DIR`.

## Yayına alma

Sunucuyu doğrudan internete açma; şifreler ve mesajlar düz HTTP'de açıkta gider. Önüne HTTPS sağlayan bir ters vekil koy. Örnek `Caddyfile`:

```
alanadin.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy, `Host` ve `X-Forwarded-Proto` başlıklarını zaten doğru iletir. Başka bir vekil kullanırsan bu iki başlığı da iletmesini sağla; `Host` gelmezse yazma istekleri reddedilir, `X-Forwarded-Proto` gelmezse çerez `Secure` olmaz.

## Raspberry Pi'de kurulum (alan adı ve port açma gerekmez)

Aşağıda kullanıcı adı `pi`, proje yolu `/home/pi/ATICOM` varsayılır; farklıysa değiştir.

1. Node 22.13 veya üstünü kur. `node -v` eskiyse:

   ```sh
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt install -y nodejs
   ```

2. Projeyi Pi'ye kopyala (`git clone` ya da aşağıdaki "Güncelleme" komutu).

3. Tailscale ile HTTPS adresi aç. Bu komut adresini (`https://<pi>.<tailnet>.ts.net`) gösterir; arkadaşların için uygulama kurmak gerekmez:

   ```sh
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   sudo tailscale funnel --bg 3000
   ```

4. `/etc/systemd/system/aticom.service` dosyasını oluştur, `BASE_URL` satırına kendi adresini yaz:

   ```ini
   [Unit]
   Description=ATICOM
   After=network-online.target
   Wants=network-online.target

   [Service]
   User=pi
   WorkingDirectory=/home/pi/ATICOM
   Environment=BASE_URL=https://PI-ADRESIN.ts.net
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

5. Davet linki üret:

   ```sh
   cd /home/pi/ATICOM && BASE_URL=https://PI-ADRESIN.ts.net node server.js invite
   ```

6. SD kart bozulursa aynı karttaki yedek de gider. USB belleği `/mnt/usb` altına bağla ve `crontab -e` ile günlük yedek ekle. Bu satır bellek takılı değilse yedek almaz, 14 günden eski yedekleri siler:

   ```
   0 4 * * * mountpoint -q /mnt/usb && cd /home/pi/ATICOM && node server.js backup /mnt/usb/aticom && find /mnt/usb/aticom -mindepth 1 -maxdepth 1 -mtime +14 -exec rm -rf {} +
   ```

## Güncelleme

Önce bilgisayarda `npm test` çalıştır. Sonra kodu Pi'ye gönder ve servisi yeniden başlat (`data/` gönderilmez, mesajlar yerinde kalır; veritabanı yapısı gerekiyorsa açılışta kendiliğinden güncellenir):

```sh
tar --exclude=data --exclude=.git -czf - -C ~/Desktop ATICOM | ssh pi@PI-ADRESI 'tar -xzf -' && ssh -t pi@PI-ADRESI 'sudo systemctl restart aticom'
```

Büyük güncellemelerden önce yedek almak iyi olur:

```sh
ssh pi@PI-ADRESI 'cd ~/ATICOM && rm -rf ~/yedek && node server.js backup ~/yedek' && scp -r pi@PI-ADRESI:yedek ~/aticom-yedek
```

Telefonlar yeni sürümü uygulama kapatılıp açılınca alır.
