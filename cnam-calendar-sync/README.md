# cnam-calendar-sync

Récupère automatiquement l'emploi du temps du Passeport Électronique de
Compétences du Cnam et le publie sous forme d'un flux `.ics`, abonnable
directement dans l'app Calendrier de ton téléphone.

## Comment ça marche

1. Un script [Playwright](https://playwright.dev) se connecte à ton
   passeport électronique avec tes identifiants, parcourt le calendrier
   mois par mois, et génère `docs/calendar.ics`.
2. Une GitHub Action lance ce script automatiquement plusieurs fois par
   jour et pousse le fichier mis à jour sur ce dépôt.
3. GitHub Pages sert ce fichier à une URL stable, que tu ajoutes comme
   "calendrier par abonnement" sur ton téléphone.

Tes identifiants Cnam ne sont **jamais** écrits dans le code : ils sont
stockés dans les "GitHub Secrets" (chiffrés, jamais affichés dans les
logs). Seul ton emploi du temps (dates, heures, codes de cours) finit
dans un fichier public de ce dépôt.

## Mise en place

### 1. Créer le dépôt

Crée un nouveau dépôt **public** sur GitHub (ex: `cnam-calendar-sync`),
et pousse-y tous les fichiers de ce dossier.

```bash
cd cnam-calendar-sync
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/TON-PSEUDO/cnam-calendar-sync.git
git push -u origin main
```

### 2. Ajouter les secrets

Dans le dépôt GitHub : **Settings > Secrets and variables > Actions >
New repository secret**. Ajoute ces trois secrets :

| Nom             | Valeur                                                                 |
|-----------------|-------------------------------------------------------------------------|
| `CNAM_USERNAME` | ton identifiant Cnam                                                    |
| `CNAM_PASSWORD` | ton mot de passe Cnam                                                   |
| `CALENDAR_URL`  | `https://pec.cnam-paysdelaloire.fr/gQkwW2owEKLp4kXzG/calendar` (ton URL exacte, avec ton token) |

### 3. Activer GitHub Pages

**Settings > Pages** :
- Source : *Deploy from a branch*
- Branch : `main`, dossier `/docs`
- Sauvegarde.

Après une ou deux minutes, ton URL publique apparaît en haut de cette
page, du type :

```
https://TON-PSEUDO.github.io/cnam-calendar-sync/calendar.ics
```

### 4. Lancer une première synchronisation

Dans l'onglet **Actions** du dépôt, sélectionne le workflow
"Update Cnam calendar", puis clique sur **Run workflow** pour le
lancer manuellement une première fois (sans attendre le prochain
créneau automatique). Ça prend 1 à 2 minutes.

Vérifie ensuite que `docs/calendar.ics` contient bien tes cours (tu
peux l'ouvrir directement sur GitHub).

### 5. Abonner ton téléphone au calendrier

**iPhone (Réglages > Calendrier > Comptes > Ajouter un compte >
Autre > Ajouter un calendrier abonné)** : colle l'URL `.ics` obtenue
à l'étape 3.

**Android (via Google Calendar sur ordinateur, calendar.google.com)** :
*Autres agendas > + > À partir de l'URL*, colle la même URL. Le
calendrier apparaît ensuite automatiquement dans l'app mobile.

Ton emploi du temps se mettra à jour tout seul, plusieurs fois par
jour, sans que tu aies plus jamais besoin de te reconnecter au site.

## Réglages ajustables

Dans `.github/workflows/update-calendar.yml` :
- `cron` : fréquence de mise à jour (par défaut 3x/jour)

Dans les secrets ou variables d'environnement du script (`scrape.js`) :
- `MONTHS_FORWARD` (défaut 6) : nombre de mois à récupérer dans le futur
- `MONTHS_BACKWARD` (défaut 1) : nombre de mois à récupérer dans le passé
- `DEFAULT_DURATION_HOURS` (défaut 3) : durée par défaut attribuée à un
  cours, car seule l'heure de **début** est visible sur le calendrier
  source (pas l'heure de fin). Ajuste cette valeur si tes cours durent
  généralement plus ou moins longtemps.

## Limites connues

- Si le site du Cnam change sa structure HTML (mise à jour de
  l'interface), le script devra être adapté en conséquence.
- Le script suppose que le formulaire de connexion (champs
  `#identifiant` / `#mdp`) apparaît automatiquement quand on visite
  l'URL du calendrier sans être connecté. Si ce n'est pas le cas,
  dis-le et on ajustera.
