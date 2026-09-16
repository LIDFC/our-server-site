# Развёртывание на Ubuntu

Инструкция для чистой Ubuntu 22.04/24.04 на той же машине, где уже работает Minecraft-сервер (Paper 1.21.11 в
`/home/ubuntu/minecraft`). В итоге получится:

- `https://mc.vin-off.site` — сайт; Minecraft продолжает работать на том же адресе, порт 25565;
- `https://map.vin-off.site` — карта squaremap.

Схема:

```
браузер ──443──> nginx ──> 127.0.0.1:3000  сайт (Node.js, systemd)
                      └──> 127.0.0.1:8080  squaremap (внутри Paper)
сайт ──> 127.0.0.1:25565  статус Minecraft (Server List Ping)
сайт ──> /home/ubuntu/minecraft/world/stats  статистика (только чтение)
```

Docker не используется. Сайт — один процесс Node.js без runtime-зависимостей, systemd запускает и ограничивает его проще и
легче, чем контейнер.

## Сколько ресурсов нужно

| Что | Память | CPU |
|---|---|---|
| Сайт (Node.js) | ~70 МБ; systemd ограничивает 200 МБ | почти ноль: запрос к Minecraft раз в 15 с при открытом сайте, чтение статистики раз в 5 мин, запись истории раз в 5 мин |
| nginx | ~10 МБ | почти ноль |
| squaremap | работает внутри JVM Paper, обычно +50–150 МБ к памяти сервера | заметная нагрузка только при первом полном рендере, потом — обновления изменённых чанков |
| Диск | сайт ~150 МБ вместе с `node_modules`, история онлайна < 100 КБ | тайлы карты: от десятков МБ до нескольких ГБ, зависит от размера мира |

---

## 1. Зависимости

```bash
sudo apt update
sudo apt install -y git nginx certbot python3-certbot-nginx
```

Node.js 24 из репозитория NodeSource (в Ubuntu по умолчанию версия старее):

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # v24.x
```

## 2. Клонирование проекта

```bash
sudo mkdir -p /opt/our-server-site
sudo chown ubuntu:ubuntu /opt/our-server-site
git clone https://github.com/LIDFC/our-server-site.git /opt/our-server-site
cd /opt/our-server-site
```

Замените адрес репозитория на свой, если назвали его иначе.

## 3. npm-зависимости

```bash
npm ci
```

`node_modules` нужен только для сборки фронтенда. Сам сервер сайта из него ничего не загружает.

## 4. Сборка фронтенда

Сначала создайте `.env` (шаг 6): значения `PUBLIC_*` подставляются в страницы при сборке.

```bash
npm run build
```

Готовый сайт появится в `dist/`.

## 5. Бэкенд

Отдельная сборка не нужна: Node.js 24 запускает `server/src/index.ts` напрямую. Проверьте, что всё в порядке:

```bash
npm run typecheck
npm test
```

## 6. Файл .env

```bash
cp .env.example .env
nano .env
chmod 600 .env
mkdir -p data
```

Главное для production:

```ini
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=true
MC_HOST=127.0.0.1
MC_PORT=25565
MC_PUBLIC_ADDRESS=mc.vin-off.site
MC_SERVER_DIR=/home/ubuntu/minecraft
MC_WORLD=world
MAP_URL=                 # оставьте пустым, пока карта не заработает (шаг 8)
PUBLIC_SITE_URL=https://mc.vin-off.site
```

Все переменные описаны в `.env.example`. При ошибке в `.env` сайт не запустится и перечислит все неверные значения в логе.
`GITHUB_TOKEN` можно не указывать: версия лаунчера кешируется на 10 минут, лимита GitHub без токена (60 запросов в час)
хватает с запасом.

## 7. Доступ к данным Minecraft

Сайт читает из папки сервера:

- `world/stats/*.json` — статистика игроков;
- `world/advancements/*.json` — достижения;
- `usercache.json` — ники.

Он работает от того же пользователя `ubuntu`, что и Minecraft, поэтому прав хватает. systemd-юнит разрешает сайту только
чтение домашней папки. Проверка:

```bash
ls /home/ubuntu/minecraft/world/stats | head
grep -E "^(enable-status|server-port|level-name)" /home/ubuntu/minecraft/server.properties
```

Нужно `enable-status=true` (значение по умолчанию). Если `level-name` не `world`, укажите его в `MC_WORLD`.

Статистику Minecraft записывает, когда игрок выходит и при автосохранении мира. Поэтому цифры на сайте отстают от игры на
несколько минут — это нормально.

## 8. Squaremap

1. Скачайте плагин для Paper 1.21.11 и перезапустите сервер:

   ```bash
   cd /home/ubuntu/minecraft/plugins
   wget https://cdn.modrinth.com/data/PFb7ZqK6/versions/GItyEkou/squaremap-paper-mc1.21.11-1.3.12.jar
   ```

   Более новые версии: https://modrinth.com/plugin/squaremap/versions?l=paper&g=1.21.11

2. После запуска появится `plugins/squaremap/config.yml`. Поменяйте настройки на экономные:

   ```yaml
   settings:
     internal-webserver:
       enabled: true
       bind: 127.0.0.1      # наружу карта открыта только через nginx
       port: 8080
     render-progress-logging:
       enabled: true
       interval-seconds: 30 # не засорять консоль

   world-settings:
     default:
       map:
         max-render-threads: 1
         background-render:
           max-render-threads: 1
           max-chunks-per-interval: 256
           interval-seconds: 30
         biomes:
           blend-biomes: 0   # меньше вычислений на каждый тайл
     # Незер и Край не рендерим: экономия CPU и диска
     minecraft:the_nether:
       map:
         enabled: false
     minecraft:the_end:
       map:
         enabled: false
   ```

   Ключи из `default` менять целиком не нужно: squaremap дополняет файл сам. Порт 8080 не открывайте в файрволе — к карте
   ходит только nginx.

3. Примените настройки: `/map reload` в консоли сервера (или перезапуск).

4. Первый рендер. Вместо полного рендера огромного мира лучше отрисовать область вокруг спавна, например радиус 2000 блоков:

   ```
   /map radiusrender minecraft:overworld 2000
   ```

   Команду удобно запускать вечером или ночью. Прогресс виден в консоли, остановить можно `/map cancelrender minecraft:overworld`,
   приостановить — `/map pauserender minecraft:overworld`. Дальше squaremap сам дорисовывает чанки, которые меняются в игре.

5. Следите за местом на диске: `du -sh /home/ubuntu/minecraft/plugins/squaremap/web/tiles`.

6. Когда карта открывается (шаг 11), впишите в `.env` `MAP_URL=https://map.vin-off.site` и перезапустите сайт
   (`sudo systemctl restart our-server-site`). Имя мира в ссылках — `MAP_WORLD=minecraft_overworld`. Проверить его можно
   кнопкой копирования ссылки в левом нижнем углу карты: там будет `?world=...`.

## 9. Домены

В DNS домена `vin-off.site` (reg.ru) должны быть A-записи на IP сервера:

| Имя | Тип | Значение |
|---|---|---|
| `mc` | A | `158.160.23.67` (уже есть) |
| `map` | A | `158.160.23.67` |

Откройте входящие TCP-порты **80** и **443** — в группе безопасности Yandex Cloud и в ufw, если он включён:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

Проверка DNS: `dig +short map.vin-off.site`.

## 10. nginx

```bash
sudo cp /opt/our-server-site/deploy/nginx/our-server-site-proxy.conf /etc/nginx/snippets/
sudo cp /opt/our-server-site/deploy/nginx/our-server-site.conf /etc/nginx/sites-available/our-server-site
sudo ln -s /etc/nginx/sites-available/our-server-site /etc/nginx/sites-enabled/our-server-site
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Конфиг включает gzip. Модуля brotli в стандартном nginx Ubuntu нет, а для сайта такого размера gzip достаточно.

## 11. HTTPS (Let's Encrypt)

```bash
sudo certbot --nginx -d mc.vin-off.site -d map.vin-off.site --redirect
```

certbot сам добавит сертификаты и перенаправление с http на https. Продление автоматическое, проверить его можно так:

```bash
sudo certbot renew --dry-run
```

Если карта ещё не настроена, выпустите сертификат только для сайта (`-d mc.vin-off.site`), а `map` добавьте позже той же
командой с обоими доменами.

## 12. systemd

```bash
sudo cp /opt/our-server-site/deploy/our-server-site.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Юнит запускает сайт от пользователя `ubuntu` и ограничивает его 200 МБ памяти и 50 % одного ядра. Писать можно только в
`/opt/our-server-site/data`, домашнюю папку — только читать. Если путь проекта или пользователь другие, исправьте
`User`, `WorkingDirectory`, `ExecStart` и `ReadWritePaths`.

## 13. Автозапуск

```bash
sudo systemctl enable --now our-server-site
sudo systemctl status our-server-site
```

После перезагрузки VPS сайт и nginx стартуют сами.

## 14. Логи

```bash
journalctl -u our-server-site -f          # сайт: статус Minecraft, ошибки галереи и статистики
journalctl -u our-server-site --since today
sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log
```

В лог сайта попадают смена состояния Minecraft-сервера («online» / «unavailable»), проблемы с файлами статистики и ошибки
в `gallery.json`.

## 15. Обновление

```bash
cd /opt/our-server-site
git pull
npm ci
npm run build
npm test
sudo systemctl restart our-server-site
```

Если изменились файлы в `deploy/`, скопируйте их заново (шаги 10 и 12) и выполните `sudo nginx -t && sudo systemctl reload nginx`
или `sudo systemctl daemon-reload`.

Галерея обновляется без перезапуска: достаточно поменять `content/gallery/gallery.json` и положить картинки в
`content/gallery/images/` (подробности в `content/gallery/README.md`).

## 16. Резервные копии

У сайта всего три ценные вещи: `.env`, история онлайна и галерея. Остальное восстанавливается из git.

```bash
mkdir -p /home/ubuntu/backups
tar -czf /home/ubuntu/backups/our-server-site-$(date +%F).tar.gz \
  -C /opt/our-server-site .env data content/gallery
```

Ежедневно по cron (`crontab -e`), с хранением последних 14 копий:

```
30 4 * * * tar -czf /home/ubuntu/backups/our-server-site-$(date +\%F).tar.gz -C /opt/our-server-site .env data content/gallery && find /home/ubuntu/backups -name 'our-server-site-*.tar.gz' -mtime +14 -delete
```

Тайлы карты копировать не нужно: squaremap отрисует их заново. Мир Minecraft резервируется отдельно.

## 17. Проверка работоспособности

```bash
# сайт отвечает локально
curl -s http://127.0.0.1:3000/api/health
curl -s http://127.0.0.1:3000/api/server/status

# через nginx и HTTPS
curl -sI https://mc.vin-off.site | head -5
curl -s https://mc.vin-off.site/api/server/players
curl -s https://mc.vin-off.site/api/launcher/release | head -c 200
curl -s "https://mc.vin-off.site/api/server/online-history?hours=24" | head -c 200

# карта
curl -sI https://map.vin-off.site | head -5

# кто слушает порты
sudo ss -tlnp | grep -E ':(80|443|3000|8080|25565)\b'
```

Что должно получиться:

- `/api/health` возвращает `{"ok":true}`;
- в `/api/server/status` при работающем Minecraft `"online":true`;
- `/api/server/stats` — `"available":true`. Если `false`, сайт не видит `world/stats`: проверьте `MC_SERVER_DIR` и `MC_WORLD`;
- порты 3000 и 8080 слушают только `127.0.0.1`, наружу открыты 80, 443 и 25565;
- на странице https://mc.vin-off.site статус совпадает с игрой, а в консоли браузера нет ошибок.

### Частые проблемы

| Симптом | Причина |
|---|---|
| `502 Bad Gateway` на сайте | сайт не запущен: `systemctl status our-server-site`, `journalctl -u our-server-site -n 50` |
| Сайт не стартует, в логе `Invalid configuration` | ошибка в `.env`, в логе перечислены все неверные значения |
| Статус всегда «Сервер выключен» | неверный `MC_HOST`/`MC_PORT` или в `server.properties` `enable-status=false` |
| Статистика «пока недоступна» | неверный путь к миру или нет прав на чтение; игроки ещё ни разу не выходили с сервера |
| Карта «пока не подключена» | пустой `MAP_URL` в `.env` — после изменения перезапустите сайт |
| Карта не загружается во встроенном окне | squaremap не слушает `127.0.0.1:8080` или нет сертификата для `map.vin-off.site` |
| Версия лаунчера не показывается | GitHub недоступен или превышен лимит — укажите `GITHUB_TOKEN` |
