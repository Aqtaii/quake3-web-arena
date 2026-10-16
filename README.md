# Quake III Arena Demo — WebAssembly

Quake III Arena'nın özgün GPL kaynakları, doğrudan wasm32 hedefiyle derlenir.
Demonun özgün q3dm1, q3dm7, q3dm17 ve q3tourney2 haritaları, BSP/AAS verileri,
modelleri, dokuları ve sesleri kullanılır. Üretilmiş arena veya kutu model yoktur.

## Çalıştırma

`node server/server.mjs` çalıştırın ve http://127.0.0.1:8081/ adresini açın.
Sunucu varsayılan olarak yalnızca bu bilgisayardan erişilebilir. Oyuncu adını
girin. Sunucu Oluştur ile özgün haritalardan birinde maç açın veya açık
sunuculardan birine / sunucu koduyla Katıl düğmesine basın.
Oyun alanına tıklayınca fare kilitlenir.
WASD hareket, Space zıplama, sol tık ateş, fare tekerleği silah değişimidir.
Esc fare kilidinden çıkış / oyun menüsüdür. Köşedeki simge tam ekranı açar.
Sayfa yalnızca online oyun kontrollerini gösterir.

## Online sunucu

`server/server.mjs` siteyi ve WebSocket bağlantılarını aynı porttan sunar.
`server/engine.mjs`, tarayıcıdakiyle aynı kaynaklardan derlenmiş `quake3.wasm`
dosyasını `dedicated 1` ile çalıştırır. Fizik, hasar ve skor özgün Quake III
sunucu kodunda hesaplanır; bir oyuncunun tarayıcısı maçın sunucusu olmaz.
Sunucu görüntü/ses oluşturmaz, PK3 içindeki indirilen programları çalıştırmaz.
Node.js'in yalnızca yerleşik modülleri kullanılır; npm paketi gerekmez.
Mevcut Node.js'i yerel test için çalıştırmaya kullanıcı ayrıca izin vermiştir.

Her odanın ayrı WASM sunucusu ve en çok 8 bağlantısı vardır. Kullanıcı
q3dm1, q3dm7, q3dm17 veya q3tourney2 seçerek oda açabilir. Altı haneli oda
kodu, açık sunucu listesi veya `?room=KOD` davet bağlantısı aynı maça götürür.
Varsayılan oda kapasitesi 2; `MAX_ROOMS` ile 1–4 arası sınırlandırılır.
Render ücretsiz planı için bellek kullanımını sınırlamak üzere 1 seçilmiştir.
Boş odalar 5 dakika sonra kapatılır. WebSocket taşıması özgün paketleri
taşır; standart masaüstü UDP istemcileri doğrudan bağlanamaz. Tarayıcı ve
sunucu aynı WASM sürümünü ve PK3 verilerini kullanmalıdır.

Render için `render.yaml` hazırdır: başlangıç `node server/server.mjs`,
sağlık kontrolü `/healthz`, `BIND_HOST=0.0.0.0`; port Render'ın `PORT`
değişkeninden okunur. HTTPS sayfalar otomatik WSS kullanır. Henüz Render'a
yayımlanmadı ve dış ağ gecikmesi / ücretsiz plan kapasitesi ölçülmedi.
Yayımlamadan önce demo medyasının dağıtım koşulları incelenmelidir.

`node tests/network-server.mjs` yerel sunucunun HTTP / WebSocket / oda
doğrulamasını kontrol eder. `online-tests.html`, iki gerçek tarayıcı WASM
istemcisini aynı odaya bağlayan geliştirici testidir; ana oyun ekranı `/`
adresidir ve tek canvas içerir.

Son doğrulama: 9/9 iki istemcili online test (aynı oda, farklı kimlik,
sohbet, sunucu hareketi, izleyici snapshotu, hareket çoğaltma, yeniden katılma,
arayüzden ikinci oda oluşturma ve odalar arası yalıtım) ile 10/10 HTTP /
WebSocket kontrolü geçti. Bu kontroller yerel bağlantıda çalıştırıldı;
Render üzerinde kapasite, gerçek internet gecikmesi ve uzun süreli kararlılık
henüz ölçülmedi. Tam ekran düğmesinin açma/kapatması tarayıcıda doğrulandı.

Arşivden çıkarılmış demo verilerini yeniden hazırlamak: `./prepare_demo.ps1`.
Kaynaklardan motoru yeniden derlemek: `./build_wasm.ps1`.
Derleme yalnızca bilgisayarda önceden bulunan LLVM/Clang araçlarını kullanır.
Yeni yazılım indirilmez; Python, npm veya Emscripten çalıştırılmaz.

## Kaynak ve veri kaydı

Motor kaynağı: https://github.com/id-Software/Quake-III-Arena.git
Devralınan HEAD: dbe4ddb10315479fc00086f08e25d968b4b43c49.
Motor lisansı: `Quake-III-Arena/COPYING.txt`.

Demo, kullanıcının açık izniyle GWDG'nin id Software FTP arşivinden indirildi.
Kaynak adresi, boyutlar ve SHA-256 kayıtları `build/demo-data/PROVENANCE.md`
içindedir. Bu kayıtlar bağımsız bir yayıncı imzası doğrulaması değildir.
İndirilen kurulum betiği, Linux programları ve paylaşılan kütüphaneler hiç
çalıştırılmadı. Arşiv Windows PowerShell ve yerleşik .NET ile veri olarak
okundu; özgün PK3 ve lisans/readme belgeleri çıkarıldı.

`web/baseq3/pak0.pk3`, çıkarılan demo paketinin değiştirilmemiş kopyasıdır:
SHA-256 e77abad2466f45a0a7ea018445528f9b95a0fe7789fa1abc1a7718bbf0754b08.
Lisans `web/baseq3/DEMO-LICENSE.txt` içinde korunur. Bu içerik tam sürüm değildir.

Motor 1.32b, demo verileri 1.11 olduğundan `pak9.pk3`, yalnızca mevcut GPL
kaynaklarından alınan `botfiles/inv.h` uyumluluk başlığını ve GPL metnini içerir.
WEAPONINDEX tanımları, demo weapons.c dosyasındaki aynı adlı tanımlarla
çakışmaması için bu başlıktan çıkarılır. Yeni oyun mantığı veya görsel eklenmez.
PK3 içindeki eski QVM'ler kullanılmaz; qagame/cgame/ui kaynaklardan derlenip
WASM'a statik bağlanır. VM ayarları başlangıçta native statik yola zorlanır.

Önceki AI'ın ürettiği paket silinmeden `build/generated-pak0.archived.pk3`
içine taşındı. Bu dosya oyun olarak yüklenmez. `build_pk3.py` yalnızca geliştirme
fixture üretimine ayrılmıştır; çalıştırılmaz ve özgün veri yerine kullanılmaz.

## Uygulanan uyarlamalar

- WebGL2 sabit işlev emülasyonu: matrisler, çoklu doku, alpha test, stencil,
  çizim durumu, portal kesme düzlemi, RGB alpha ve texture-env davranışı.
- Tarayıcı monitör gamma rampası destekliyormuş gibi bildirilmez; özgün
  motorun yazılımsal gamma yolu kullanılır.
- Özgün AAS botu korunur. Basitleştirilmiş takip/ateş yaması kaldırılmıştır.
- Özel libc'de `%lf` double okuma düzeltildi; BSP eşya konumlarının sıfıra
  dönüşmesi giderildi. Bellek hizalaması, malloc/calloc taşmaları, EOF/seek ve
  okuma hataları da düzeltildi.
- Giriş tuşlarının bırakılması, odak kaybı, fiziksel WASD eşlemesi ve olay
  zamanlarının motor saatiyle eşleştirilmesi düzeltildi.
- WebAudio DMA halkasında yeniden örneklenen PCM, tüketimi bitmeden silinmez.
- Ayarlar temel paketin SHA-256 kimliğine göre saklanır; eski üretilmiş paketin
  vertex-light/model ayarları gerçek oyuna taşınmaz. Veriler ve ayarlar yereldir.
- Harita listesi gerçek PK3 merkez dizininden okunur. Kullanıcı paketleri
  IndexedDB'de saklanır ve temiz motor açılışıyla bağlanır.

## Doğrulama

`./build_tests.ps1` ardından http://127.0.0.1:8080/tests.html:
**20/20 WASM/PK3 testi** geçti. Bellek, dosya okuma, double koordinat ayrıştırma,
ondalıklı çıktı ve ZIP dizini/sınır kontrolleri doğrulandı.

http://127.0.0.1:8080/game-tests.html sayfasındaki Testleri Başlat düğmesi:
**8/8 entegrasyon testi** geçti. Dört özgün haritanın yüklenmesi/çizilmesi,
BSP eşya koordinatları, oyuncu hareketi/fizik, AAS botunun konum değiştirmesi ve
WebAudio'dan sıfır olmayan PCM çıkışı kontrol edildi. Bu ölçüm işitsel kalite
veya masaüstü oyunla kare kare görüntü eşitliği garantisi değildir.

Test amaçlı salt okunur WASM durum snapshotu `wasm_q3_status` exportudur.
Tarayıcı test köprüsü yalnızca `?test=1` ile açıldığında etkinleşir.
Normal sayfa bu köprüyü dışa açmaz.

## Sınırlar

Bu demo portunda tam sürümün tüm haritaları mevcut
değildir. WebSocket üzerinden ortak sunucu bağlantısı eklenmiştir. Depth/stencil
`glReadPixels` eşdeğeri (flare ve overdraw tanısı), bazı eski OpenGL işlemleri
ve uzun süreli kararlılık için ek çalışma gerekir. Demo paketinde bulunmayan
sonraki sürüm sesleri/efektleri için motor uyarı verebilir; sahte içerik eklenmez.
Uygulama içi tarayıcı fare kilidini engelleyebilir; bu durumda konsola açıklama
verilir. Firefox/Chrome gibi normal tarayıcılarda yerel adres kullanılabilir.

Demo portunun testlerden geçmesi, tüm Quake III sürümlerinin birebir uyumlu
olduğu veya masaüstü sürümüyle tüm grafik/oynanış durumlarının doğrulandığı
anlamına gelmez.
