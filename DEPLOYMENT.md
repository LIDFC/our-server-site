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

# аккаунты, подробности в шаге 18
REGISTER_INVITE_CODE=придумайте-секретный-код
COOKIE_SECURE=true

# скины, подробности в шаге 19
SKIN_UPLOAD_DIR=/opt/our-server-site/uploads/skins
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

У сайта ценны `.env`, папка `data` (история онлайна и база аккаунтов `site.db`), загруженные скины в `uploads` и
галерея. Остальное восстанавливается из git. Копируйте `data` целиком: рядом с `site.db` лежат файлы `site.db-wal` и
`site.db-shm`. Скины и база связаны, поэтому копируйте их одной командой — иначе после восстановления ссылка на скин
будет вести в пустоту.

```bash
mkdir -p /home/ubuntu/backups
tar -czf /home/ubuntu/backups/our-server-site-$(date +%F).tar.gz \
  -C /opt/our-server-site .env data uploads content/gallery
```

Ежедневно по cron (`crontab -e`), с хранением последних 14 копий:

```
30 4 * * * tar -czf /home/ubuntu/backups/our-server-site-$(date +\%F).tar.gz -C /opt/our-server-site .env data uploads content/gallery && find /home/ubuntu/backups -name 'our-server-site-*.tar.gz' -mtime +14 -delete
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
| «Регистрация закрыта» | пустой `REGISTER_INVITE_CODE` в `.env` — после изменения перезапустите сайт |
| Вход не запоминается | сайт открыт по `http` при `COOKIE_SECURE=true`: браузер не сохраняет `Secure`-cookie |
| `SQLITE_CANTOPEN` в логе | нет прав на `DATA_DIR`: он должен принадлежать пользователю `ubuntu` и быть в `ReadWritePaths` |
| Скин не загружается, в логе `EACCES` | нет прав на `SKIN_UPLOAD_DIR` или его нет в `ReadWritePaths` юнита (шаг 19) |
| «Файл не является корректным Minecraft-скином» | картинка не 64×64 и не 64×32 или это не PNG/JPG — расширение роли не играет |
| Ссылка на скин открывается, а в игре скин не меняется | команда `/sr createcustom` не выполнена или SkinsRestorer не видит домен: проверьте, что ссылка открывается без входа |
| После `/skin clear` скин остаётся на сайте | в логе Minecraft нет строки про синхронизацию: не задан `OUR_SERVER_API_TOKEN` (или `website.api-token`), либо токен не совпадает с `MINECRAFT_API_TOKEN` сайта |
| В логе Minecraft `status 401` | токены на сайте и в плагине разные; после правки `.env` нужен `systemctl restart our-server-site` |

## 18. Аккаунты

Аккаунты нужны для профиля игрока и будущих скинов. Отдельной СУБД ставить не надо: данные лежат в SQLite-файле
`/opt/our-server-site/data/site.db`, а схема создаётся и обновляется сама при запуске сайта — миграции выполняются на
старте, отдельной команды нет. В логе после перезапуска не должно быть ошибок SQLite.

Переменные в `.env`:

| Переменная | Значение | Смысл |
|---|---|---|
| `REGISTER_INVITE_CODE` | секретный код, минимум 6 символов | без него регистрация закрыта; код выдаёте игрокам вы |
| `COOKIE_SECURE` | `true` | cookie сессии только по HTTPS; ставьте `false` лишь для локальной разработки |
| `SESSION_TTL_DAYS` | `30` | сколько живёт вход; каждое посещение продлевает |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `900` | окно защиты от подбора пароля |
| `AUTH_RATE_LIMIT_MAX_REQUESTS` | `10` | сколько попыток входа и регистраций разрешено в окне (на адрес и на логин) |

Требования к прокси: сайт принимает `POST` только с `Content-Type: application/json` и только если заголовок `Origin`
совпадает с `Host`. Caddy и конфигурация nginx из `deploy/` передают исходный `Host` как есть — менять ничего не нужно.
HTTPS обязателен: без него браузер не сохранит `Secure`-cookie и вход не будет запоминаться.

Обслуживание аккаунтов (пароль вводится скрытно, в логи и историю команд не попадает):

```bash
cd /opt/our-server-site
npm run users list
npm run users create Lev LevPlays        # аккаунт вручную, без кода приглашения
npm run users set-password Lev           # сброс забытого пароля, все сессии закрываются
npm run users set-nick Lev LevTheBuilder
npm run users logout-all Lev
npm run users delete Lev
```

Проверка после запуска:

```bash
# без входа профиль недоступен
curl -s -o /dev/null -w '%{http_code}\n' https://mc.vin-off.site/api/auth/me     # 401

# у cookie сессии есть HttpOnly, SameSite и Secure
curl -si -X POST https://mc.vin-off.site/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"нет","password":"нет"}' | head -3   # 401, один и тот же ответ
```

Затем зарегистрируйтесь через браузер на https://mc.vin-off.site/register с кодом приглашения: после этого в шапке сайта
появится ваш ник, а страница профиля откроется без повторного входа.

## 19. Скины

Скины лежат обычными PNG-файлами на диске, в базе хранится только запись о владельце и ссылка.

```bash
mkdir -p /opt/our-server-site/uploads/skins
chown -R ubuntu:ubuntu /opt/our-server-site/uploads
# папка для записи, файлы только на чтение и никогда не исполняются
chmod 750 /opt/our-server-site/uploads /opt/our-server-site/uploads/skins
```

Переменные в `.env`:

| Переменная | Значение | Смысл |
|---|---|---|
| `SKIN_UPLOAD_DIR` | `/opt/our-server-site/uploads/skins` | где лежат файлы; путь наружу не попадает |
| `PUBLIC_SITE_URL` | `https://mc.vin-off.site` | из него строится постоянная ссылка на скин |
| `SKIN_MAX_UPLOAD_BYTES` | `8388608` | жёсткий предел на сервере, 8 МБ |
| `SKIN_UPLOAD_COOLDOWN_SECONDS` | `20` | пауза между двумя загрузками одного аккаунта |
| `SKIN_UPLOAD_LIMIT_WINDOW_SECONDS` / `SKIN_UPLOAD_LIMIT_MAX_REQUESTS` | `600` / `10` | не больше десяти загрузок за десять минут с адреса |

Права и прокси:

- папку `uploads` пишет только сервис (`ubuntu`); в systemd-юните она указана в `ReadWritePaths`, всё остальное вне
  `data` и `uploads` остаётся только для чтения;
- исполняемых файлов там быть не может: сайт принимает только PNG и JPG и пересохраняет их как PNG;
- отдельной настройки прокси не нужно — `/skins/<имя>.png` отдаёт сам сайт через тот же `reverse_proxy` (Caddy) или
  `proxy_pass` (nginx), с `Content-Type: image/png`. Каталог не листается: любой адрес, кроме точного имени файла,
  отвечает 404. Если захотите отдавать файлы напрямую nginx, добавьте
  `location /skins/ { alias /opt/our-server-site/uploads/skins/; autoindex off; }` — но это не обязательно;
- новая таблица `skins` создаётся автоматически при первом запуске обновлённого сайта, отдельной команды миграции нет.

Проверка после перезапуска:

```bash
# без входа — 401, каталог и чужие имена — 404
curl -s -o /dev/null -w '%{http_code}\n' https://mc.vin-off.site/api/skins/me
curl -s -o /dev/null -w '%{http_code}\n' https://mc.vin-off.site/skins/
curl -s -o /dev/null -w '%{http_code}\n' "https://mc.vin-off.site/skins/../../data/site.db"
```

Затем на https://mc.vin-off.site/skins загрузите скин 64×64 и откройте показанную ссылку: браузер должен показать
картинку с `Content-Type: image/png`. В игре останется выполнить показанную на странице команду
`/sr createcustom <имя> "<ссылка>"` и применить скин: `/skin set <имя>`. Имя по умолчанию — ваш ник, поменять его можно
на той же странице.

## 20. Синхронизация скинов с Minecraft

Когда игрок делает в игре `/skin clear`, скин должен исчезать и на сайте. Этим занимается плагин
[our-server-plugin](https://github.com/LIDFC/our-server-plugin): он замечает команду, спрашивает SkinsRestorer, остался
ли скин, и сообщает сайту. Сайт удаляет запись и файл. Прямого доступа к базе у Minecraft нет.

**1. Общий токен.** Придумайте длинный случайный секрет и пропишите его на сайте:

```bash
openssl rand -hex 32
```

```bash
printf '\nMINECRAFT_API_TOKEN=вставьте-сюда-токен\n' >> /opt/our-server-site/.env && systemctl restart our-server-site
```

Без токена эндпоинт отвечает `503 integration-disabled` — интеграция просто выключена.

**2. Плагин.** Соберите jar (GitHub Actions в репозитории плагина → последняя сборка → Artifacts → `OurServerPlugin`)
и положите его в `/home/ubuntu/minecraft/plugins/` рядом со SkinsRestorer 15.x. Токен лучше передать через окружение
сервера Minecraft, а не файлом:

```ini
# в systemd-юните Minecraft
Environment=OUR_SERVER_API_TOKEN=тот-же-токен
```

Если сервер запускается скриптом, можно прописать токен в `plugins/OurServerPlugin/config.yml` (`website.api-token`),
там же задаётся `website.base-url: "https://mc.vin-off.site"`. После этого перезапустите сервер Minecraft.

**3. Проверка.**

```bash
# без токена и из браузера эндпоинт закрыт
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mc.vin-off.site/api/internal/minecraft/skin-cleared \
  -H 'Content-Type: application/json' -d '{"minecraftUuid":"00000000-0000-0000-0000-000000000000"}'
```

Ожидаем `401`. Дальше в игре: применить скин с сайта, затем `/skin clear` — через пару секунд страница «Скины»
показывает «У вас пока нет сохранённого скина», а ссылка на файл отвечает 404. В логе Minecraft видно
`Player <uuid> cleared their skin; synchronising the website account.` и `Website skin removed for Minecraft UUID <uuid>.`

Если сайт в этот момент недоступен, `/skin clear` всё равно работает: плагин повторит запрос несколько раз с растущей
паузой и напишет одну строку WARNING, а затем ERROR, если так и не достучался.

**Как аккаунт связывается с игроком.** Первый запрос приходит с UUID и ником; сайт сверяет пару с
`usercache.json` самого сервера, находит аккаунт по нику и запоминает UUID в `users.minecraft_uuid`. Дальше всё идёт по
UUID, и смена ника в профиле ничего не ломает. Если UUID неизвестен сайту, ответ — `{"success":true,"deleted":false,
"reason":"account_not_found"}`: удалять нечего, ошибки нет.
