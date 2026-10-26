# Horaris

Aplicació web per fer horaris de centres educatius (totes les etapes), a l'estil d'aSc Horaris.

## Com s'executa

Doble clic a `inicia.bat` (cal Python 3), o bé:

```
python server.py
```

i obre http://localhost:8000. No cal instal·lar res més: el servidor és Python estàndard (SQLite) i la web és HTML + JavaScript sense compilació.

### Versió en línia sense servidor

També es pot fer servir directament a https://xplanas5.github.io/horaris/ (GitHub Pages). Sense `server.py` l'aplicació entra en **mode local**: no hi ha inici de sessió ni usuaris, i els centres es desen només en aquell navegador (localStorage). Fes-ne còpies amb **Còpia JSON**; esborrar les dades del navegador les elimina.

### Usuaris i dades

- Les dades (centres, horaris, usuaris) es desen al servidor, a `data/horaris.db`. **Fes-ne còpies de seguretat** (n'hi ha prou de copiar el fitxer amb el servidor aturat).
- Els canvis es desen sols uns instants després de fer-los (a la barra inferior: «✓ Desat»). Si dues persones editen el mateix centre alhora, la segona rep un avís i tria si recarrega o desa igualment.
- **Administradors**: veuen tots els centres i, des de *⚙ Administració*, creen i eliminen centres i usuaris i vinculen cada usuari als seus centres.
- **Usuaris de centre**: només veuen i editen els centres que tenen vinculats.
- Cada usuari pot canviar la seva contrasenya des del botó amb el seu nom.
- Crear un administrador, o recuperar-ne la contrasenya, des de la línia d'ordres: `python server.py admin correu@xtec.cat --nom "Nom"`.

### Perquè els centres hi entrin des de fora

Per defecte el servidor només escolta en aquest ordinador. Per obrir-lo a la xarxa: `python server.py --host 0.0.0.0 --port 8000`.
Per fer-lo accessible des d'internet cal un servidor (del CRP, del Departament o un allotjament amb Python) i **posar-lo darrere d'HTTPS** (per exemple amb Caddy o nginx) i iniciar-lo amb `--cookie-segura`. Sense HTTPS les contrasenyes viatgen sense xifrar.

## Què fa ara

- **Diversos centres i usuaris** amb inici de sessió; còpia de seguretat i restauració de cada centre en JSON.
- **Dades**: centre, dies, franges (amb patis), matèries, grups amb desdoblaments, professorat amb disponibilitat, aules i càrregues lectives.
- **Graella** per grups, professorat o aules. Arrossega o clica sessions de la safata; les cel·les verdes són vàlides i les vermelles mostren el motiu.
- **Detecció de conflictes**: docent o grup ocupat, aula ocupada, franja no lectiva, docent no disponible. Respecta els desdoblaments (grups d'una mateixa divisió poden coincidir).
- Desfer/refer, impressió de la vista actual, mida de cel·la ajustable.
- **Normes** (📏): regles per a la col·locació automàtica i manual. Cada norma és *obligatòria* (la cel·la queda vermella i el generador no la incompleix) o *preferent* (es permet amb un avís △ i el generador l'evita si pot):
  - **No seguides**: unes matèries no poden anar seguides en un grup (sense matèries: cap matèria dues hores seguides). El pati separa.
  - **Matèria en franges concretes**: una matèria només / mai a unes franges (p. ex. EF només a la tarda). Sense matèries s'aplica a tot el grup.
  - **Màxim de sessions al dia** d'una mateixa matèria.
  - **Bloqueig de docents**: hores reservades per a diversos docents amb un motiu (reunions, coordinacions…). Es veuen ratllades a la vista de professorat.
- **Guàrdies i coordinació**: a *Professorat* s'indiquen les hores setmanals de guàrdia i de coordinació de cada docent. ⚡ Omple les col·loca després de les classes. La norma **Cobertura de guàrdies** (mínim de docents de guàrdia a cada hora) fa que les guàrdies es reparteixin per no deixar cap hora descoberta; a la vista de professorat la fila 🛡 en mostra el recompte.
- **Baixes i substitucions** (🩺): registre d'absències per dates. Per a cada dia mostra les classes que queden sense docent i en proposa substituts automàticament: primer qui és de guàrdia a aquella hora, després qui coneix el grup o la matèria, repartint les substitucions de la setmana. Es pot canviar cada proposta i baixar el **full de substitucions del dia** en PDF.
- **Bloqueja hores**: a la vista de professorat, el botó 🔒 permet marcar hores no disponibles clicant la graella.
- **Exporta horaris** (📄): horaris individuals de grups, professorat, matèries o aules en **PDF** o en **Excel** (s'obre com a Full de càlcul de Google en pujar-lo a Drive). Tots en un sol fitxer (una pàgina o full per horari) o un fitxer per horari dins d'un .zip. També es pot exportar l'horari d'una fila seleccionada des del panell inferior.
- **⚡ Omple**: col·locació automàtica voraça amb reparació i diversos intents; respecta les normes i informa de les sessions que no hi caben.

## Estructura

| Fitxer | Contingut |
|---|---|
| `js/model.js` | Model de dades, normalització, centre d'exemple |
| `js/conflicts.js` | Restriccions dures: validesa d'una col·locació i conflictes |
| `js/rules.js` | Normes (obligatòries / preferents) i les seves comprovacions |
| `server.py` | Servidor: fitxers estàtics, API, usuaris, sessions i base de dades SQLite |
| `js/api.js` | Crides a l'API (passa al mode local si no hi ha servidor) |
| `js/local.js` | Mode local: API simulada sobre el localStorage del navegador |
| `js/store.js` | Sessió, estat del centre obert, historial (desfer) i desat automàtic al servidor |
| `js/absences.js` | Baixes, propostes de substitució i full del dia |
| `js/admin.js` | Inici de sessió, compte propi i administració de centres i usuaris |
| `js/export/` | Horaris individuals i generació de PDF, Excel (.xlsx) i .zip sense biblioteques externes |
| `js/main.js` | Graella, safata, panell de detall, arrossegar |
| `js/editor.js` | Finestra d'edició de dades |
| `js/solver/greedy.js` | Col·locació automàtica (voraç + reparació) |
| `tests/` | Proves: `python tests/run.py` (API, navegador amb Edge, mode local i validació dels PDF/Excel) |

## Properes fases

1. Més normes: forats del professorat, hores màximes seguides per docent, repartiment per dies.
2. Generador més potent (p. ex. OR-Tools CP-SAT al servidor).
3. Importació des de full de càlcul.
