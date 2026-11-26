# Aracın çalıştırılması (Node.js sürümü)

> English version: [how-to-run.md](how-to-run.md). Birini değiştirdiğinizde ikisini de güncel tutun.

Aracın günlük kullanılan birkaç komutu vardır. **Hangi API'nin** test edileceğini her zaman `--target` ile
belirtirsiniz. Hedefler (target) `config/apitest.yaml` dosyasında tanımlıdır.

| Hedef adı | Nedir | İstek gönderir mi? |
|---|---|---|
| `simpleapi` | apichallenges.com Simple API (spec internetten indirilir) | evet, saniyede 1 istek |
| `simpleapi_offline` | aynı API, spec `tests/fixtures/` klasöründen okunur | yalnızca `run` istek gönderir |
| `epiasQA` | EPİAŞ reporting-service (TGT ile kimlik doğrulama). QA linki girilene kadar canlı sunucuyu gösterir | evet, saniyede 5 istek (`company-test`) |

---

## Windows'ta (iş bilgisayarı): hiçbir şey kurmanız gerekmez

Gereken tek şey **Node.js 18 veya üstü**; bu, bilgisayarda zaten var. PowerShell veya cmd'de kontrol edin:
```powershell
node --version        # v18.x, v20.x, v22.x ... hepsi uygundur
```
`npm install`, Python, yönetici yetkisi veya herhangi bir indirme gerekmez. Proje klasörü her şeyi içerir;
YAML ayrıştırıcısı da `vendor/` altında kopyalanmış tek bir dosyadır.

### Tek seferlik kurulum
1. Proje klasörünün tamamını (`API_Manuel_Test_Tool_with_NodeJS`) bilgisayara kopyalayın, örneğin
   `C:\Users\<kullanıcı>\apitest` altına. `runs/` klasörünü almayabilirsiniz. Şirketinizin izin verdiği
   yolu kullanın: OneDrive/SharePoint klasörü, e-postayla zip ya da USB bellek.
2. O klasörde PowerShell açın (Gezgin'de: Shift + sağ tık → *PowerShell penceresini buradan açın*).

### Günlük kullanım
```powershell
.\apitest.cmd --help
.\apitest.cmd analyze  --target simpleapi_offline
.\apitest.cmd generate --target simpleapi_offline --dry-run
.\apitest.cmd run      --target simpleapi --level standard
start runs\simpleapi\<runId>\report.html
```
**cmd.exe**'de baştaki `.\` gerekmez; `apitest.cmd run ...` ya da yalnızca `apitest run ...` çalışır.
`node src\cli.js <komut> ...` da tamamen aynı işi yapar.

İş servisleriniz TGT'nizi ister. Yalnızca bu pencere için ayarlayın; diske hiçbir zaman yazılmaz:
```powershell
$env:TGT_TOKEN = "<TGT değeriniz>"
.\apitest.cmd run --target <hedefiniz> --level smoke
```
**cmd.exe**'de yazım farklıdır: tırnak yok ve `=` işaretinin çevresinde boşluk yok:
```cmd
set TGT_TOKEN=<TGT değeriniz>
apitest run --target <hedefiniz> --level smoke
```
Değişken yalnızca o pencerede geçerlidir. Yeni bir pencere açarsanız ya da TGT'nizin süresi dolarsa
(çıkış kodu 2) yeniden ayarlayın. Süre dolduktan sonra `run --resume <runId>` ile kaldığınız yerden devam edin.
Rapordaki curl komutlarının, `curl.exe` ve `$env:...` kullanan bir **PowerShell** sekmesi vardır.

### Spec'in yalnızca bir kısmını test etmek (tek controller veya tek endpoint)
Bir çalıştırmayı iki şekilde sınırlayabilirsiniz. İkisi de aynı operasyonları seçer:
- **Config'de**, hedefin varsayılanı olarak: `config/apitest.yaml` içindeki `filters:` bloğu
  (Mac bölümünde, ["Spec'in yalnızca bir kısmını test etmek"](#specin-yalnızca-bir-kısmını-test-etmek-tek-controller-veya-tek-endpoint-1)
  başlığında anlatılıyor; YAML Windows'ta da aynıdır).
- **Komut satırında**, yalnızca o çalıştırma için, şu dört parametreyle:

| Parametre | Operasyonları neye göre seçer | Örnek değer |
|---|---|---|
| `--tag` | Swagger tag'i (Swagger UI'da görünen controller adı) | `reportind-data-controller` |
| `--path` | path, servis base path'i **olmadan**; `*` joker karakterdir | `/v1/data/eligible-consumer-and-meter-increases` veya `/v1/data/*` |
| `--method` | HTTP metodu | `GET`, `POST`, `PUT`, `DELETE` |
| `--operation` | operationId; `*` joker karakterdir | `"get_*"` |

Parametreler nasıl birleşir:
- Bu parametrelerden **herhangi biri**, o çalıştırma için hedefin **`filters:` bloğunun tamamının yerine geçer**.
  Vermediğiniz parametreler config'den alınmaz; yalnızca "sınır yok" anlamına gelir.
- Birden fazla değere izin vermek için bir parametreyi **birkaç kez** verin (VEYA): `--method GET --method POST` = GET **veya** POST.
- **Farklı** parametrelerin **hepsi** eşleşmelidir (VE): `--path "/v1/data/*" --method POST` = `/v1/data/` altındaki POST'lar.

**Önce her zaman dry-run ile bakın.** Hiç test göndermez (`epiasQA` için yalnızca Swagger'ı indirir) ve
hangi filtrenin etkin olduğunu ve hangi test case'lerinin çalışacağını yazdırır:
```powershell
.\apitest.cmd generate --target epiasQA --dry-run                                       # filtre config'den
.\apitest.cmd generate --target epiasQA --dry-run --tag reportind-data-controller       # filtre parametreden
```
Bir tag veya path hiçbir şeyle eşleşmezse uyarı alırsınız. Tag için uyarı, spec'teki tüm tag'leri listeler;
böylece yazım hatası kolayca görülür. `.\apitest.cmd analyze --target epiasQA` de tüm tag'leri ve operasyonları listeler.

**PowerShell örnekleri** (önce `$env:TGT_TOKEN` ayarlayın, yukarıya bakın):
```powershell
# 1. Controller'ın tamamı (bir Swagger tag'i altındaki tüm endpoint'ler)
.\apitest.cmd run --target epiasQA --tag reportind-data-controller

# 2. Tam olarak tek bir endpoint
.\apitest.cmd run --target epiasQA --path "/v1/data/eligible-consumer-and-meter-increases"

# 3. /v1/data/ altındaki tüm endpoint'ler, ama yalnızca POST olanlar
.\apitest.cmd run --target epiasQA --path "/v1/data/*" --method POST

# 4. Tek çalıştırmada iki endpoint (parametreyi tekrarlayın)
.\apitest.cmd run --target epiasQA --path "/v1/data/eligible-consumer-and-meter-increases" --path "/v1/data/<diğer-endpoint>"

# 5. Tek çalıştırmada iki controller
.\apitest.cmd run --target epiasQA --tag reportind-data-controller --tag <diğer-controller>

# 6. Yalnızca operationId'si "get" ile başlayan operasyonlar
.\apitest.cmd run --target simpleapi --operation "get*"

# 7. Önce tek bir endpoint'e hızlı bir kontrol, sonra o endpoint için testlerin tamamı
.\apitest.cmd run --target epiasQA --path "/v1/data/eligible-consumer-and-meter-increases" --level smoke
.\apitest.cmd run --target epiasQA --path "/v1/data/eligible-consumer-and-meter-increases" --level standard

# 8. Parametre yok: config/apitest.yaml içindeki hedefin filters: bloğu kullanılır
.\apitest.cmd run --target epiasQA
```

**Aynısı cmd.exe'de:**
```cmd
set TGT_TOKEN=<TGT değeriniz>
apitest run --target epiasQA --tag reportind-data-controller
apitest run --target epiasQA --path "/v1/data/eligible-consumer-and-meter-increases"
apitest run --target epiasQA --path "/v1/data/*" --method POST
```

**Windows'ta tırnak kullanımı** (en sık yapılan hata):
- **Çift tırnak** `"..."` kullanın. cmd.exe'de tek tırnak, tırnak *değildir*: `'/v1/data/x'` araca `'`
  karakterleriyle birlikte ulaşır ve hiçbir şeyle eşleşmez. (Mac örnekleri tek tırnak kullanır;
  Windows'ta bunları çift tırnağa çevirin.)
- `*`, boşluk, `&`, `|`, `<`, `>` veya `^` içeren değerleri her zaman tırnak içine alın.
- Path'leri Windows'ta bile Swagger'daki gibi düz eğik çizgiyle `/` yazın.
- `--tag`, `--path` ve `--operation` büyük/küçük harfe duyarlıdır; değerleri Swagger UI'dan veya
  `analyze` çıktısından kopyalayın. `--method` duyarlı değildir (`post` = `POST`).

### Şirket ağı: proxy ve sertifikalar
- **Proxy:** `config/apitest.yaml` içinde `proxy:` ayarlayın (ör. `http://proxy.company.local:8080`) ya da
  `HTTPS_PROXY` ortam değişkenini ayarlayın. İç sunucular için `NO_PROXY` dikkate alınır.
  Windows oturum açması isteyen (NTLM/Kerberos) proxy'ler desteklenmez. Sizinki böyleyse IT'den iç test
  sistemleri için oturum açma istemeyen bir proxy adresi veya bir no-proxy kuralı isteyin.
- **Şirket TLS sertifikası** (`unable to get local issuer certificate` veya
  `self-signed certificate in certificate chain` hatası): şirketinizin kök sertifikasını `.pem`
  dosyası olarak dışa aktarın (IT sağlayabilir) ve `config/apitest.yaml` içinde
  `ca_bundle: C:/yol/company-root.pem` ayarlayın. Alternatif olarak:
  ```powershell
  $env:NODE_EXTRA_CA_CERTS = "C:\yol\company-root.pem"
  ```
  Node 22.15 veya üstünde (ya da 23.8 veya üstünde) `$env:NODE_OPTIONS = "--use-system-ca"`, Node'un
  doğrudan Windows sertifika deposuna güvenmesini sağlar.

### PowerShell ipuçları
- Joker karakterli değerleri ve `&`, `|`, `<`, `>` veya `^` içeren her şeyi tırnak içine alın, örneğin `--operation "get_*"`.
- Ctrl+C bir çalıştırmayı düzgünce durdurur. O anki istek tamamlanır, ardından çalıştırmanın oluşturduğu
  her şey silinir. Ctrl+C'ye ikinci kez basmak hemen çıkar; bu durumda `.\apitest.cmd cleanup --run <runId>` kullanın.

---

## Mac'te

Terminal'i açın ve proje klasörüne gidin:
```bash
cd ~/Desktop/API_Manuel_Test_Tool_with_NodeJS
```
`./apitest` aracı başlatır. Komutlar Windows'takiyle aynıdır.

### Adım 1: API'ye bakın (API'nin kendisine istek gönderilmez)
```bash
./apitest analyze --target simpleapi_offline
```
Bu şunları gösterir:
- API'nin kaç operasyonu olduğu;
- hangi alanların hangi kurallara sahip olduğu;
- kimlik doğrulama (auth) ayarı;
- spec'teki sorunlar.

### Adım 2: hangi testlerin çalışacağını görün (dry-run, hiçbir şey göndermez)
```bash
./apitest generate --target simpleapi_offline --dry-run
./apitest generate --target simpleapi_offline --dry-run --level full --csv cases.csv   # tüm case'ler bir CSV'ye
```

### Adım 3: testleri gerçekten çalıştırın
```bash
./apitest run --target simpleapi --level smoke       # hızlı: her operasyon için bir geçerli istek (~20 sn)
./apitest run --target simpleapi --level standard    # baseline + zorunlu alanlar + veri tipleri ... (~4 dk)
```
Sonunda bir özet ve HTML raporunun yolunu yazdırır.

### Adım 4: raporu açın
```bash
open runs/simpleapi/*/report.html
```
Raporda:
- **1. Defects** API'nin hatalı davrandığı yerleri listeler. İsteği, yanıtı ve curl komutunu görmek için bir satıra tıklayın.
- **Copy for ticket** başlık, adımlar, beklenen ve gerçekleşen sonuçla hazır bir hata kaydı açıklamasını kopyalar.
- **4. Cleanup problems** boş olmalıdır: aracın oluşturduğu her şey yeniden silinmiştir.

### Faydalı seçenekler
```bash
./apitest run --target simpleapi --operation "get_*"          # yalnızca bazı operasyonlar (operationId üzerinde glob)
./apitest run --target simpleapi --method GET --method DELETE  # yalnızca bazı HTTP metotları
./apitest run --target simpleapi --tag items                   # yalnızca tek bir tag
./apitest run --target epiasQA --path '/v1/data/eligible-consumer-and-meter-increases'   # tek endpoint
./apitest report --run <runId>                                 # rapor dosyalarını yeniden oluştur
./apitest cleanup --run <runId>                                # bir çalıştırma çöktüyse artakalanları sil
```

### Kimlik bilgisi isteyen API'ler (ör. TGT'niz)
Araç hiçbir zaman oturum açmaz. Değeri siz verirsiniz, tercihen bir ortam değişkeniyle:
```bash
export TGT_TOKEN=<ticket değeriniz>
./apitest run --target <iş-hedefiniz>
```
Kimlik bilgisi verilmezse, kimlik bilgisi gerektiren operasyonlarda yalnızca "eksik kimlik bilgisi
reddedilmeli" testi çalışır. Diğer testleri SKIPPED olarak görünür.

### Spec'in yalnızca bir kısmını test etmek (tek controller veya tek endpoint)
İki yol vardır. İkisi de aynı operasyonları seçer.

**1. Config'de, hedefin varsayılanı olarak:** `config/apitest.yaml` içindeki bir hedefin `filters:` bloğu.
Komut satırında filtre parametresi vermediğiniz her durumda `generate` ve `run` için geçerlidir.
```yaml
  epiasQA:
    ...
    filters:
      tags: [reportind-data-controller]     # yalnızca bu Swagger tag'i altındaki servisler
      paths: []                             # ya da tek endpoint: ['/v1/data/eligible-consumer-and-meter-increases']
      methods: []                           # ör. [POST]
      operations: []                        # operationId glob'ları
```
- Boş listeler (veya hiç `filters:` bloğu olmaması) = tüm operasyonlar.
- Bir listedeki değerler VEYA ile, farklı listeler VE ile birleşir. **Yalnızca** tek bir endpoint'i test
  etmek için onu `paths` içine yazın ve `tags` listesini boşaltın (ya da tag'i bırakın: bu durumda
  endpoint'in o tag'e de sahip olması gerekir).
- `paths`, servis base path'i **olmadan** Swagger path'i üzerindeki glob'lardır: `/v1/data/*` =
  `/v1/data/` altındaki tüm endpoint'ler.

**2. Komut satırında, tek çalıştırma için:** `--tag`, `--path`, `--method`, `--operation` (hepsi tekrarlanabilir).
Bu parametrelerden herhangi biri, o çalıştırma için `filters:` bloğunun **tamamının yerine geçer**.
```bash
./apitest generate --target epiasQA --dry-run                                   # config'deki filters: kullanılır
./apitest run --target epiasQA --tag reportind-data-controller                  # controller'ın tamamı
./apitest run --target epiasQA --path '/v1/data/eligible-consumer-and-meter-increases'   # tek endpoint
./apitest run --target epiasQA --path '/v1/data/*' --method POST                # /v1/data/ altındaki tüm POST'lar
```
`generate` hangi filtrenin etkin olduğunu yazdırır. Hiçbir şeyle eşleşmeyen bir tag veya path uyarı
yazdırır; tag için uyarı spec'teki tüm tag'leri listeler, böylece yazım hatası kolayca görülür.
`./apitest analyze --target epiasQA` de spec'in tag'lerini ve operasyonlarını listeler.

---

## Yeni bir Swagger eklemek (yeni bir hedef)
Hedef eklemek **yalnızca config işidir**: kod değişikliği gerekmez. Şirket içi veya herkese açık, her API bu şekilde çalışır.

### Adım 1: `config/apitest.yaml` dosyasına bir kayıt ekleyin
Yalnızca `spec` zorunludur; diğer tüm anahtarlar isteğe bağlıdır. Bir EPİAŞ servisi için `epiasQA`
kaydını kopyalayın ve `spec`, `base_url` ve `filters` değerlerini değiştirin:
```yaml
  my_service:                       # herhangi bir ad; --target my_service olarak kullanırsınız
    spec: https://my-test-env.company.local/my-service/v2/api-docs   # URL veya kaydedilmiş bir .json/.yaml dosyası
    base_url: https://my-test-env.company.local/my-service           # servis base path'ini içermelidir
    profile: company-test           # yazılmazsa = public-demo (en fazla 2 istek/sn); iş servisleri için company-test kullanın
    auth:                           # yalnızca API kimlik bilgisi istiyorsa
      header: TGT
      env: TGT_TOKEN
      unauth_expect: [401, 403, 302]
      login_redirect_pattern: "/cas/login"
    exports:                        # yalnızca API'nin dosya dışa aktarma (export) endpoint'leri varsa
      tag_pattern: "-export-controller$"
      type_field: exportType
    overrides: config/overrides/epias.yaml   # isteğe bağlı, aşağıdaki "İsteğe bağlı dosyalar" bölümüne bakın
    rules: [config/rules/epias.yaml]         # isteğe bağlı, aşağıdaki "İsteğe bağlı dosyalar" bölümüne bakın
    filters: { tags: [], paths: [] }         # isteğe bağlı: spec'in yalnızca bir kısmını test et
    allow_null_in_responses: true            # isteğe bağlı: yanıttaki null alan hata sayılmaz (aşağıya bakın)
```
- `base_url`: EPİAŞ servislerinde base path `/<ad>-service` şeklindedir (ör. `/reporting-service`). Bu olmadan
  istekler sunucunun köküne gider ve başarısız olur. `base_url` yazmazsanız araç sunucuyu Swagger'ın
  kendisinden alır.
- Ortam değiştirmek (ör. canlı → QA) = `spec` ve `base_url` içindeki sunucu adresini değiştirmek.
- `allow_null_in_responses`: bazı servisler (tüm EPİAŞ servisleri), Swagger alanı sayı veya metin olarak
  tanımlasa bile veri olmadığında o alan için `null` döner. Bu seçenek olmadan böyle her yanıt, ör.
  `data.items[0].value must be number` hatasıyla başarısız olur. `true` olduğunda, her yanıt gövdesinin
  **her** alanında `null` kabul edilir (gövdenin tamamının `null` olması da). `null` olmayan değerler yine
  tam olarak kontrol edilir (tip, enum, min/max, ...) ve zorunlu alanlar yine bulunmalıdır. Varsayılan:
  `false`. `epiasQA` için açıktır.

### Adım 2: kontrol edin (test gönderilmez; yalnızca Swagger indirilir)
```bash
./apitest analyze  --target my_service              # sunucular, tag'ler, hangi endpoint'ler kimlik bilgisi istiyor, doküman sorunları
./apitest generate --target my_service --dry-run    # hangi test case'leri çalışacak
```
Hedef eklemeden yalnızca bir Swagger'a bakmak için: `./apitest analyze --spec <url veya dosya>`.

### Adım 3: çalıştırın
Önce `--level smoke`, sonra `--level standard`, ardından rapora bakın.

### Testler nereden gelir
1. **Swagger'ın kendisi (otomatik, her hedef).** Tipler, zorunlu alanlar, min/max, uzunluklar, enum'lar
   ve formatlar teste dönüşür: eksik zorunlu alan, sınırın bir fazlası olan değer, yanlış tip, ...
   Testlerin çoğu buradan gelir.
2. **`config/rules/domain_rules.yaml` (otomatik, her hedef).** Çoğu API'nin geçmesi gereken genel
   kontroller; ör. her tarih alanına `2023-02-30` gönderilir (reddedilmelidir). Bu dosyayı hiçbir zaman
   listelemezsiniz; her zaman yüklenir (hedefte `use_default_rules: false` ile kapatılır).
3. **Hedefin kendi kural dosyası (isteğe bağlı, siz yazarsınız).** Swagger'ın yalnızca açıklama metninde
   belirttiği, aracın okuyamadığı kurallar. Örnekler: Simple API "type cd, dvd, book veya blu-ray
   olmalı" kuralını yalnızca metinde söyler; EPİAŞ "sayfa boyutu 10, 20, 24, 50 veya 100 olmalı" der.
   Aşağıdaki "Kendi kurallarınızı eklemek" bölümüne bakın.

### İsteğe bağlı dosyalar: bunlara ihtiyacım var mı?
| Anahtar | Nedir | Ne zaman gerekir |
|---|---|---|
| `rules:` | açıklama metninden gelen ek kurallar | **Başta gerekmez.** Yalnızca metinde geçen önemli bir sınır fark ederseniz sonradan ekleyin. Başka bir EPİAŞ servisi `config/rules/epias.yaml` dosyasını yeniden kullanabilir. Bu API için yanlış olan bir varsayılan kuralı değiştirmek için de kullanılır (aynı `id`). |
| `overrides:` | geçerli baseline isteği için sabit değerler | Yalnızca araç geçerli bir isteği kendisi tahmin edemiyorsa (ör. EPİAŞ `page` nesnesini ister). EPİAŞ servisleri `config/overrides/epias.yaml` dosyasını yeniden kullanır. |
| `resources:` | test verisinin nasıl oluşturulup silineceği | Yalnızca **veri oluşturan veya silen** servisler için; böylece araç arkasını temizleyebilir. Salt okunur rapor servislerinin buna ihtiyacı yoktur. Örnek: `config/resources/simpleapi.yaml`. |
| `known_issues:` | zaten bildiğiniz hatalar | Yalnızca bilinen hataları raporda işaretlemek için. |

**Kısacası:** yalnızca `spec`, `base_url`, `profile` ve `auth` ile başlayın, çalıştırın ve diğer
dosyaları yalnızca rapor ihtiyacınız olduğunu gösterirse ekleyin.

---

## Çıkış kodları (script'lerde faydalı)
| Kod | Anlamı |
|---|---|
| 0 | her şey yolunda |
| 1 | hata (defect) bulundu veya temizleme sorunları var |
| 2 | durduruldu: sunucu sağlıksızdı veya kimlik bilgisinin süresi doldu |
| 3 | yanlış kullanım veya config |

## Neler test edilir
| Teknik | Neyi kontrol eder | Seviye |
|---|---|---|
| **BASE** | Her operasyon için bir geçerli istek. Başarısız olursa operasyonun diğer testleri atlanır. | smoke |
| **AUTH** | Eksik, boş, bozuk veya yanlış önekli kimlik bilgisi reddedilmelidir. Yalnızca kimlik bilgisi isteyen operasyonlar için. | smoke |
| **B-required** | Her zorunlu alan gönderilmediğinde, `null`, `""` veya yalnızca boşluk olduğunda reddedilmelidir. Yalnızca zorunlu alanları göndermek çalışmalıdır. | standard |
| **A-datatype** | Yanlış tipler, int32/int64 taşması, enum dışındaki veya yanlış büyük/küçük harfli değerler, pattern ihlalleri. | standard (full'da daha fazlası) |
| **C-boundary** | Spec'teki min/max ±1, uzunluk ve öğe sayısı sınırları. Spec'in sınır belirtmediği yerlerde: **full** seviyede genel sınırlar ve "constraint missing" doküman bulgusu. | standard / full |
| **D-domain** | Spec'in ifade etmediği kurallar: tarih formatları, tarih aralıkları, sayfalama, sıralama ve yalnızca açıklamalarda yazan kurallar. `config/rules/*.yaml` içinde tanımlıdır. | standard / full |
| **E-protocol** | Bozuk JSON, boş gövde, dizi olarak gövde, yanlış Content-Type, bilinmeyen alan, dokümante edilmemiş metot → 405, bilinmeyen path → 404, olmayan ID → 404 ve (full'da) özel karakterler, unicode, çok uzun metinler. | standard / full |
| **F-export** | Bir export operasyonunun her dosya tipi (XLSX/CSV/PDF): dosya imzası, Content-Type, dosya adı, "dosya yerine JSON". `--include-exports` gerektirir. | standard |
| **E-injection** | SQL/script/template metinleri. `--allow-injection` ve buna izin veren bir profil gerektirir; herkese açık demo sunucularda asla. | full |
| **F (her test)** | Durum kodu, Content-Type, yanıt süresi, dokümante edilmiş şemaya göre gövde (hata gövdeleri dahil; hedefte `allow_null_in_responses: true` varsa `null` alanlar geçer), 2xx içindeki hata zarfı (envelope). | her zaman |

### İstek gövdesi tipleri
Bir operasyon JSON kabul ediyorsa her zaman JSON kullanılır. Aksi halde araç şunları gönderir:
- **form** (`application/x-www-form-urlencoded`);
- **multipart** (`multipart/form-data`), dosya alanları için üretilmiş küçük bir PNG ile;
- **binary** (`application/octet-stream`).

PNG, çalıştırma klasörüne `apitest.png` olarak kaydedilir; böylece rapordaki curl komutları o klasörden çalıştırıldığında çalışır.

### Yalnızca değişeni test etmek
```bash
./apitest diff old_spec.json new_spec.json             # alan alan neyin değiştiği
./apitest diff <runId> https://.../openapi.json        # önceki bir çalıştırmanın kaydettiği spec ile karşılaştır
./apitest run --target simpleapi --changed-since <runId>   # yalnızca yeni + değişen operasyonları çalıştır
```

### Kendi kurallarınızı eklemek
Yalnızca dokümantasyonda var olan kurallar, hedefin `rules:` altında listelenen bir YAML dosyasına yazılır (isteğe bağlı; yukarıdaki "Testler nereden gelir" bölümüne bakın). Örneğin Simple API'nin "price 0 ile 50000 arasında olmalı" kuralı:
```yaml
rules:
  - id: SIMPLE-PRICE-ABOVE-MAX
    match: { location: body, name: "^price$" }
    value: 50000.01
    expect: reject          # reject = 4xx beklenir · accept = 2xx beklenir · no_5xx = yalnızca sunucu hatası olmasın
```
Varsayılan bir kuralla (`config/rules/domain_rules.yaml`) aynı `id`'ye sahip bir kural, o hedef için onun
yerine geçer. Bunu örneğin bir servisin gerçek en uzun tarih aralığını ayarlamak ya da bu API için yanlış
olan bir varsayılan kuralın `expect` değerini değiştirmek için kullanın (ör. servis saat dilimi olmayan
tarihleri doğru şekilde kabul ediyorsa: `DATE-NO-OFFSET` kuralını `expect: accept` ile yeniden tanımlayın).

### Her çalıştırmanın çıktı dosyaları
`runs/<target>/<runId>/`:
- `report.html`: rapor
- `junit.xml`: CI araçları için
- `results.csv` ve `results.xlsx`: sonuçlarıyla tüm case'ler, ayrıca Summary ve Findings sayfaları
- `results.jsonl`, `run.json`, `run.log`, `spec_snapshot.json`, `created_resources.jsonl`: ham veri

Herhangi birini `apitest report --run <runId> --format html,junit,csv,xlsx` ile yeniden oluşturun.
