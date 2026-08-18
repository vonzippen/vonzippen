# Von Zippen — On Stage Drive Sync

This setup makes Google Drive the source of truth for the On Stage slideshow.

Flow:

`Google Drive / On Stage` → `Apps Script` → `GitHub / images/on-stage` → `GitHub Pages`

## One-time setup

### 1. Create the Drive folder

Create a folder in Google Drive, e.g. `Von Zippen — On Stage`.
Put the photos you want on the website in that folder. JPG/JPEG, PNG, WEBP and GIF are supported.

For the first sync, put the current On Stage photos in this folder. After that, adding/removing photos in Drive controls the slideshow.

### 2. Create a GitHub fine-grained token

In GitHub, create a **fine-grained personal access token** for the `vonzippen/vonzippen` repository.
Give it only:

- Repository access: **Only selected repositories → vonzippen/vonzippen**
- Repository permissions: **Contents → Read and write**

Do not put this token in the website or commit it to GitHub. It belongs only in Apps Script Script Properties.

### 3. Create the Apps Script

Go to `script.google.com` and create a new project.

Create two files in the project:

- `Code.gs` — copy the contents of `Code.gs` from this folder
- `Index.html` — copy the contents of `Index.html` from this folder

Save the project.

### 4. Deploy it as a private web app

In Apps Script:

**Deploy → New deployment → Web app**

Use:

- Execute as: **Me**
- Who has access: **Only myself**

Authorize the requested Google Drive permissions. The web app is only a small private control panel for you.

### 5. Open the web app

Open the web-app URL while signed into the Google account that owns the Drive folder.

Open **First-time setup** and enter:

- the Drive folder ID — the long string in the folder URL after `/folders/`
- the GitHub fine-grained token

Press **SAVE SETUP**.

### 6. Test it

Press **SYNC NOW**.

The first sync will:

- copy every supported image from Drive into `images/on-stage/` on GitHub;
- update `images/on-stage.json`;
- make the On Stage page use those images;
- report how many files were added, updated and removed.

After the first successful sync, the Drive folder is the source of truth.

## How it behaves later

- Add a photo to Drive → Sync → it appears on the site.
- Replace/update a photo with the same filename → Sync → GitHub copy is updated.
- Delete a photo from Drive → Sync → it is removed from `images/on-stage/` and disappears from the slideshow.
- Rename a photo → treated as one deletion + one new photo.

The site itself remains hosted by GitHub Pages. Google Drive is only the management/source folder.

## Security note

The GitHub token is stored in Apps Script's Script Properties and is never written into the public repository. Keep the web app restricted to yourself and never paste the token into HTML, JavaScript, GitHub files, or the public site.
