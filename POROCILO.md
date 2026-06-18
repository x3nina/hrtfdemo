# Prostorska lokalizacija zvoka s HRTF: digitalna obdelava signalov

*Poročilo o spletni demonstraciji za prostorsko predvajanje zvoka (Web Audio API).*

---

## 1. Uvod (Introduction)

Ko zvok prispe do naših ušes, ga možgani znajo umestiti v prostor — povedo nam,
ali prihaja z leve ali desne, od spredaj ali zadaj, od zgoraj ali spodaj. To je
mogoče zato, ker glava, uhlji (*pinna*) in trup spremenijo zvočni val, preden ta
doseže bobnič. Sprememba je odvisna od **smeri**, iz katere zvok prihaja. Ključni
namigi, ki jih sluh uporablja, so:

- **ITD (interaural time difference)** — časovna razlika prihoda zvoka med levim
  in desnim ušesom. Zvok z leve prispe v levo uho nekaj deset mikrosekund prej.
- **ILD (interaural level difference)** — razlika v glasnosti med ušesoma. Glava
  »osenči« bolj oddaljeno uho, zlasti pri visokih frekvencah.
- **Spektralni namigi** — uhelj deluje kot majhen, smerno odvisen filter, ki
  ojača oziroma oslabi določene frekvence. Prav ti namigi omogočajo razločevanje
  zgoraj/spodaj in spredaj/zadaj, kjer sta ITD in ILD skoraj enaka.

Vse te učinke skupaj zajame **HRTF (Head-Related Transfer Function)** — prenosna
funkcija, ki opisuje, kako se signal iz neke smeri preoblikuje na poti do ušesa.
V časovnem prostoru ji ustreza **HRIR (Head-Related Impulse Response)**, torej
impulzni odziv. Za vsako smer in vsako uho obstaja svoj HRIR.

**Cilj te demonstracije** je v realnem času sintetizirati prostorski zvok: vzamemo
mono posnetek (npr. mijavkanje, rožljanje dežja, rožnati šum) in poslušalcu skozi
slušalke ustvarimo vtis, da prihaja iz poljubne smeri okoli glave. Aplikacija to
počne na dva načina, ki ju primerjamo:

1. **Vgrajeni `PannerNode`** brskalnika (Web Audio API) — »črna škatla«, ki
   uporablja generičen HRTF nabor. Preprosto, a ne omogoča izbire profila.
2. **Lastna konvolucijska pot** — naložimo izmerjene HRIR-je iz datotek SOFA
   (baza IRCAM LISTEN) in sami izvedemo konvolucijo, interpolacijo med smermi in
   prehode. Ta pot je osrednja tema tega poročila.

---

## 2. Metode (Methods)

### 2.1 Vir podatkov: izmerjeni HRIR-ji (IRCAM LISTEN)

HRIR-jev ne računamo iz modela glave, temveč uporabimo **izmerjene** podatke iz
baze IRCAM LISTEN. Ti so shranjeni v standardnem formatu **SOFA** (datoteke
`IRC_XXXX_R_44100.sofa`), ki je v osnovi datoteka HDF5. Beremo jih s knjižnico
`h5wasm` v brskalniku.

Pomembna polja v datoteki (konvencija `SimpleFreeFieldHRIR`):

- `Data.IR` — oblike `[M, 2, N]`: `M` izmerjenih smeri, `2` ušesi (0 = levo,
  1 = desno), `N` vzorcev na impulzni odziv.
- `SourcePosition` — oblike `[M, 3]`: za vsako meritev `[azimut°, elevacija°,
  razdalja]`.
- `Data.SamplingRate` — vzorčna frekvenca meritev (44 100 Hz).

Vsako meritev pri nalaganju razčlenimo: kot smeri pretvorimo v **enotski vektor**
na krogli, IR-je pa razpakiramo iz 3D-polja v ločena polja `left`/`right`
(`loadSofaSet` v `SofaLoader.ts`).

**Koordinatna konvencija** (enaka v aplikaciji in v datotekah SOFA, zato
preslikava ni potrebna): azimut 0° = spredaj, 90° = levo, 180° = zadaj, 270° =
desno; elevacija 0° = vodoravno, +90° = nad glavo. Pretvorba kota v vektor:

```
x = -sin(az)·cos(el)     (levo/desno)
y =  sin(el)             (gor/dol)
z =  cos(az)·cos(el)     (spredaj/zadaj)
```

### 2.2 Osnova: konvolucija po ušesih

Sinteza prostorskega zvoka je v jedru **konvolucija** vhodnega signala z ustreznim
HRIR-jem, posebej za vsako uho:

```
levi_izhod[n]  = (vhod * HRIR_levo)[n]
desni_izhod[n] = (vhod * HRIR_desno)[n]
```

V praksi to izvedeta dva ločena `ConvolverNode`-a (levi in desni), katerih izhoda
združimo v stereo signal s `ChannelMergerNode`. `ConvolverNode` brskalnika interno
uporablja **particionirano hitro konvolucijo** (FFT po blokih), kar omogoča delo v
realnem času. Postavili smo `normalize = false`, da ohranimo izmerjeno amplitudo
HRIR-jev (sicer bi brskalnik energijsko normaliziral odziv in pokvaril ILD).

### 2.3 Iskanje najbližje smeri

Baza vsebuje le končno število izmerjenih smeri (red velikosti nekaj sto točk na
krogli). Za poljubno želeno smer poiščemo **najbližjo izmerjeno** točko z
maksimizacijo **skalarnega produkta** med enotskima vektorjema:

```
dot = q·v   (q = želena smer, v = izmerjena smer)
```

Največji skalarni produkt pomeni najmanjši kot med smerema (`findNearest`). Ta
preprost pristop zadostuje za prvi odziv (preden se predpomnilnik ogreje), za
gladko izkušnjo pa uporabimo interpolacijo med več sosedi (spodaj).

### 2.4 Interpolacija med smermi v spektralni domeni

Če bi pri premikanju vira preprosto preklapljali na najbližji izmerjeni HRIR, bi
bili prehodi slišno stopničasti. Naivno mešanje (linearna interpolacija) surovih
HRIR-jev pa povzroči **glavnikasto filtriranje** (*comb filtering*): ker se
impulzi rahlo razlikujejo v zakasnitvi/fazi, se ob seštevanju delno odštejejo in
nastanejo umetni izrezi v spektru.

Rešitev v tej demonstraciji je interpolacija v **spektralni domeni z
rekonstrukcijo minimalne faze** (`tryBlendedBuffersSync`):

1. **Izberi 4 najbližje sosede** (`findNeighbors`) in jim določi uteži. Utež je
   `dot⁸`, nato normalizirana, da je vsota 1. Visoka potenca (`^8`) poskrbi, da
   ima najbližji sosed izrazito prevladujočo težo, oddaljeni pa hitro izgubljajo
   vpliv — interpolacija je tako lokalna in ostra.
2. **Izračunaj magnitudni spekter** vsakega soseda s FFT: `|H[k]| = √(Re² + Im²)`.
   Ti spektri se predračunajo enkrat in predpomnijo (`magnitudeSpectraCache`).
3. **Uteženo seštej magnitudne spektre** sosedov (interpolacija poteka samo nad
   *jakostmi* frekvenc, ne nad fazo).
4. **Rekonstruiraj impulzni odziv z minimalno fazo** iz zmešanega magnitudnega
   spektra (`minimumPhaseFromMagnitude`). Ker mešamo le magnitude, se problem
   glavnikastega filtriranja izogne; manjkajočo fazo pa določimo enolično prek
   **realnega kepstra**:

   ```
   log|H|  →  IFFT  →  kepstrum  →  vzročno (causal) liftranje
           →  FFT  →  exp(·)  →  IFFT  →  h_min[n]
   ```

   Vzročno okno (vrednosti 1/N, 2/N, …) zloži negativni del kepstra na
   pozitivnega, kar je matematični pogoj za sistem z minimalno fazo — torej
   stabilen, vzročen filter z najmanjšo možno skupinsko zakasnitvijo za dani
   magnitudni odziv.

Vsa FFT obdelava uporablja lastno **radix-2 Cooley-Tukey FFT** (`fftInPlace`),
ki deluje na dolžini, zaokroženi navzgor na potenco števila 2 (`nextPow2`).

### 2.5 Vzorčna frekvenca in predogrevanje predpomnilnika

Meritve so pri 44 100 Hz, `AudioContext` pa lahko teče pri drugačni frekvenci
(npr. 48 000 Hz). Če se frekvenci ne ujemata, IR-je **prevzorčimo** prek
`OfflineAudioContext` (`resampleIfNeeded`). Pri ujemajočih se frekvencah ni
nobenega dela.

Po izbiri profila se izvede **predogrevanje** (`prewarmResampledIRs`): vse
meritve se prevzorčijo in vsi magnitudni spektri predračunajo vnaprej. Posledica:
ko je predpomnilnik »topel«, je vsaka posodobitev položaja **popolnoma
sinhrona** — brez asinhronega dela med predvajanjem, kar je nujno za posodobitve
pri ~60 Hz.

### 2.6 Gladki prehodi: navzkrižno pojemanje med dvema rezinama

Tudi z interpolacijo bi takojšnja zamenjava bufferja v konvolverju lahko povzročila
klik. Zato sta na voljo **dve konvolverski rezini** (`ConvSlot`), med katerima se
izvede **kratko navzkrižno pojemanje (~15 ms)**. Ob posodobitvi položaja
(`schedulePositionUpdate`):

1. nov (interpoliran) IR se naloži v neaktivno rezino,
2. ojačanje aktivne rezine se z `setTargetAtTime` zapelje proti 0, ojačanje nove
   pa proti 1 (eksponentni prehod, časovna konstanta `fade/3`),
3. zastavica `isCrossfading` prepreči prekrivanje prehodov, dokler tekoči ni
   končan.

(Opomba: dokumentacija `CLAUDE.md` opisuje starejšo enorezinsko različico z
neposredno zamenjavo bufferja; trenutna koda v `SofaLoader.ts`/`HRTFEngine.ts`
uporablja zgoraj opisano spektralno interpolacijo z dvema rezinama in prehodom.)

### 2.7 Razdalja in vrtenje glave poslušalca

- **Razdalja**: po konvolucijski poti se modelira kot preprosto slabljenje
  ojačanja `1 / max(1, d)` (`convolverDistGain`). HRIR sam ostane enak; spreminja
  se le glasnost.
- **Orientacija poslušalca**: v igralnem načinu poslušalec vrti glavo (yaw/pitch),
  vir pa miruje. Iz orientacije glave izračunamo **relativno smer** vira glede na
  glavo (`relativeDir`): smerni vektor vira projiciramo na lokalne osi glave
  (naprej/desno/gor) in iz tega dobimo relativni azimut in elevacijo, ki ju nato
  uporabimo za izbiro/interpolacijo HRIR-ja.

### 2.8 Primerjalna pot: vgrajeni `PannerNode`

Za primerjavo je na voljo brskalnikov `PannerNode` s `panningModel = 'HRTF'`.
Ta uporablja generičen vgrajen HRTF nabor; položaj vira podamo kot kartezične
koordinate, oddaljenost pa po modelu `inverse`. Tu nimamo nadzora nad profilom
niti nad interpolacijo — vse opravi brskalnik.

---

## 3. Rezultati (Results)

- **Delujoča prostorska sinteza po dveh poteh.** Tako vgrajeni `PannerNode` kot
  lastna konvolucijska pot ustvarita prepričljiv vtis smeri zvoka skozi slušalke.
  Lastna pot dodatno omogoča izbiro merjenega HRTF profila (različni posamezniki
  iz baze LISTEN).

- **Gladko premikanje vira v realnem času.** Kombinacija (a) interpolacije med 4
  sosedi v magnitudni domeni, (b) rekonstrukcije minimalne faze in (c)
  15-milisekundnega navzkrižnega pojemanja med dvema konvolverjema da slišno
  zvezne prehode brez klikov in brez glavnikastega filtriranja, ki bi nastalo ob
  naivnem mešanju surovih IR-jev.

- **Sinhrone posodobitve po ogrevanju.** Zaradi predračunanega prevzorčenja in
  predpomnjenih magnitudnih spektrov vsaka posodobitev položaja teče sinhrono,
  kar omogoča osveževanje pri hitrosti sličic (~60 Hz) brez prekinitev zvoka.

- **Ohranjena izmerjena amplituda.** Z izklopom normalizacije konvolverja
  (`normalize = false`) so ohranjene razlike v jakosti med ušesoma (ILD), kot so
  izmerjene v bazi.

- **Smiselno modeliranje razdalje in vrtenja glave.** Razdalja vpliva na glasnost
  (`1/d`), vrtenje glave pa pravilno prevede smer vira v relativni okvir glave,
  tako da zvok ob obračanju »ostane na mestu« v prostoru.

---

## 4. Razprava (Discussion)

### 4.1 Glavna kompromisa

**Interpolacija samo magnitude + minimalna faza.** Ta odločitev odpravi
glavnikasto filtriranje in da numerično stabilne, vzročne filtre. Cena je, da
**zavržemo izvirno fazo** izmerjenih HRIR-jev. Ker se faza rekonstruira iz
magnitude (minimalna faza), se **interauralna časovna razlika (ITD)** ne ohrani
natančno — ostane le toliko zakasnitve, kolikor je »vsebovane« v magnitudnem
odzivu vsakega ušesa. ITD je sicer močan namig predvsem pri nizkih frekvencah; v
praksi ILD in spektralni namigi (ki *so* ohranjeni v magnitudi) še vedno dajo
prepričljivo lokalizacijo, a stroga zvestoba ITD-ju je žrtvovana za gladkost
prehodov. To je smiselno za interaktivno demonstracijo, manj pa za psihoakustično
natančne meritve.

**Razdalja kot zgolj slabljenje.** Model `1/d` ne zajema bližnjepoljskih učinkov
(sprememba ILD pri zelo bližnjih virih), niti odbojev prostora ali zračnega
slabljenja visokih frekvenc na daljavo. Za vtis razdalje zadostuje, fizikalno pa
je poenostavitev.

### 4.2 Omejitve podatkov in metode

- **Negeneričnost / individualnost.** HRTF je močno odvisen od oblike posamezne
  glave in uhljev. Uporabljamo tuje meritve (LISTEN), zato lahko pride do
  **zamenjav spredaj/zadaj** in slabše ocene elevacije — klasične težave pri
  neindividualiziranih HRTF.
- **Goste meritve, a končna mreža.** Interpolacija med 4 sosedi je dobra, a v
  predelih z redkejšimi meritvami (npr. nizke elevacije) je rezultat manj
  zanesljiv.
- **Utež `dot⁸`** je hevristična: zelo lokalna, kar je dobro za ostrino, a lahko
  v mejnih primerih povzroči hitrejši prehod, kot bi ga dala mehkejša utež.
- **Brez dekorelacije/odmeva.** Sinteza je »suha« (anehoična); manjka akustika
  prostora, ki bi v resnici dodatno pomagala pri zaznavi razdalje in
  eksternalizacije (občutku, da zvok prihaja od zunaj, ne iz glave).

### 4.3 Možne izboljšave

- **Ločena interpolacija ITD-ja**: ohraniti čisto interauralno zakasnitev posebej
  (npr. iz modela ali iz izmerjenih maksimumov navzkrižne korelacije) in jo
  dodati k minimalno-faznemu jedru — to bi povrnilo natančnost nizkofrekvenčne
  lokalizacije ob hkratni ohranitvi gladkosti.
- **Bližnjepoljski popravki** za majhne razdalje.
- **Dodajanje rahlega prostorskega odziva** za boljšo eksternalizacijo.
- **Individualizacija HRTF** (izbira profila, ki se ujema z uporabnikom, ali
  prilagoditev po antropometriji) za zmanjšanje zamenjav spredaj/zadaj.

### 4.4 Zaključek

Demonstracija pokaže celotno verigo digitalne obdelave signalov za prostorski
zvok: branje izmerjenih HRIR-jev iz SOFA, iskanje smeri prek skalarnega produkta
na krogli, konvolucijo po ušesih, interpolacijo v spektralni domeni z
rekonstrukcijo minimalne faze prek realnega kepstra ter gladke prehode z
navzkrižnim pojemanjem. Rezultat je odziven sistem za sintezo smernega zvoka v
realnem času. Glavni inženirski kompromis — interpolacija samo magnitude — gladkost
in stabilnost postavi pred strogo zvestobo fazi (ITD), kar je za interaktivno
demonstracijo razumna in dobro delujoča izbira.
```
