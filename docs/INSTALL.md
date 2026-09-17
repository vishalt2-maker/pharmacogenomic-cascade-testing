# Installing on a machine that has nothing on it

The README says Node 22.18 or later is the only prerequisite. That is true and
it is unhelpful on a laptop that has never had a developer tool installed,
where `git` and `npm` are both absent. This page assumes exactly that.

**You do not need git.** Downloading a ZIP from GitHub is enough, and it avoids
a large Xcode download on macOS. Use git only if you want to pull later changes.

---

## macOS

### 1. Install Node

Go to **https://nodejs.org** and download the macOS installer, the `.pkg` file.
Take the LTS version as long as it is 22.18 or higher.

Double-click it and click through. No terminal required. The installer puts both
`node` and `npm` on your PATH.

> If you have Homebrew already, `brew install node` works too. If you do not,
> do not install Homebrew just for this: Homebrew itself requires the Xcode
> Command Line Tools, which is a multi-gigabyte download you do not need.

### 2. Get the code

Open **https://github.com/vishalt2-maker/pharmacogenomic-cascade-testing**,
click the green **Code** button, and choose **Download ZIP**.

Double-click the downloaded file. It expands to a folder called
`pharmacogenomic-cascade-testing-main`. Move it somewhere sensible, such as your
Documents folder.

### 3. Run it

Open **Terminal** from Applications → Utilities. Type `cd ` with a trailing
space, then **drag the folder from Finder into the Terminal window**, which
fills in the path for you. Press Return.

```bash
npm install
npm start
```

Then open **http://localhost:8787** in a browser.

### About that Xcode dialog

If you ran `git clone` and got:

```
xcode-select: note: No developer tools were found, requesting install.
```

that is macOS telling you git is not installed. It offers to install the Xcode
Command Line Tools, which is several gigabytes and takes a while.

- Using the ZIP instead: **cancel the dialog.** You do not need it.
- Wanting git, so you can pull later updates: let it install, wait for it to
  finish, then run the `git clone` again.

The `cd: no such file or directory` and `command not found: npm` that followed
were consequences, not separate problems. The clone never happened because git
was missing, so there was no folder to enter, and npm was missing because Node
was not installed either.

---

## Windows

### 1. Install Node

Either open a terminal and run:

```
winget install OpenJS.NodeJS.LTS
```

Or go to **https://nodejs.org**, download the Windows Installer `.msi`, and
click through it.

**Close and reopen your terminal afterwards.** A terminal opened before the
install will not see `node` on its PATH.

### 2. Get the code

Open **https://github.com/vishalt2-maker/pharmacogenomic-cascade-testing**,
click the green **Code** button, and choose **Download ZIP**.

In File Explorer, right-click the downloaded ZIP and choose **Extract All**.

### 3. Run it

Open the extracted folder in File Explorer. Click in the address bar, type
`cmd`, and press Return. That opens a command prompt already in that folder.

```
npm install
npm start
```

Then open **http://localhost:8787** in a browser.

> **Run the two commands on separate lines.** Windows PowerShell 5.1, which is
> still the default in many setups, does not support `&&` between commands.
> Command Prompt does, and so does PowerShell 7, but separate lines work
> everywhere.

---

## Checking it worked

```
node --version
```

Must print `v22.18.0` or higher. If it prints something lower, or nothing at
all, Node is the problem and nothing else will work until it is fixed.

```
npm test
```

Runs 240 tests. This is the best single check that the machine is set up
correctly, because it exercises the database, the safety engine, the document
renderer and the HTTP layer without you having to click anything.

To stop the server, press **Ctrl+C** in the terminal window.

---

## If something goes wrong

**`command not found: npm` or `'npm' is not recognized`**
Node is not installed, or the terminal was open before you installed it. Close
the terminal, open a new one, and try again.

**`This project needs Node 22.18 or later`**
Exactly what it says. The project runs TypeScript without a build step, and that
became default behaviour in Node 22.18. Install a newer Node from nodejs.org.

**`EADDRINUSE` or the page will not load**
Something else is on port 8787. Use another port:

```
npm run setup
PORT=9000 npm run serve          # macOS
set PORT=9000 && npm run serve   # Windows Command Prompt
```

**The screen loads but there are no cases**
That is the normal starting state. Log a case with the form on the left, or
turn on **Demo shortcuts** in the header and use **Run the demonstration
sequence**.

**`RuntimeError: Aborted()` on startup, or the server will not start again**
The local database directory is damaged. This happens if the process is killed
abruptly rather than stopped with Ctrl+C, which is easy to do by closing a
terminal window mid-demonstration. Rebuild it:

```
npm run setup
```

Nothing of value is lost. The database is scratch and is rebuilt from the
migrations and the seed every time.

**You want to start over**
`npm run setup` deletes the local database and rebuilds it. If you want the
demonstration data back as well, follow it with `npm run demo`.

**Before a demonstration**
Stop the server with Ctrl+C rather than closing the window, and if the machine
has been sitting idle, run `npm run setup && npm run demo` once beforehand so
you are not rebuilding anything in front of an audience.

---

## What gets installed where

Nothing goes into your system. There is no database server, no Docker, and no
build step.

| Thing | Where it lives |
|---|---|
| The one dependency | `node_modules/` inside the project folder |
| The database | `.data/pgdata/` inside the project folder |
| Rendered advisories from `npm run demo` | `demo-output/` inside the project folder |

Deleting the project folder removes all of it. The database is PostgreSQL 18
compiled to WebAssembly, running inside the Node process, so there is no service
left behind and nothing listening after you press Ctrl+C.

---

## A note on what has been tested

The macOS path in this document has been run end to end on a clean machine:
ZIP download, `npm install`, `npm test` with all 240 passing, and the server
serving.

The Windows path has **not** been executed on a Windows machine. What has been
checked is that the project contains no Unix-only shell commands, no hardcoded
POSIX paths, and that the test runner's file pattern is expanded by Node rather
than by the shell, which is the usual cause of a test script working on macOS
and failing on Windows. If something does go wrong there, it is worth reporting
rather than working around.
