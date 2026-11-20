---
url: http://localhost:4310/projects
login: demo@example.com / demo1234
length: 60
color: "#4F46E5"
---

# Projectly

Projectly is a lightweight project tracker for small teams. The videos are for new users.

<!-- This is the practice app: start it with `npm run example-app`, then run `app-story example`.
     Its demo password is fake, so it is written here directly. For a real app, use env:NAME. -->

## Tips for the demo

- The app opens on the Projects list, with counts per status. Use the left menu to move
  between Projects, Team and Settings.
- Use realistic but made-up names, like "Q3 Product Launch".
- After creating something, show that it appears on the Projects list.
- Stay away from the Team and Settings pages: they invite members and delete the workspace.

## Release notes

### Added
- **Create a project**: the **+ New project** button on the Projects page opens a form with
  *Project name*, *Description*, *Status* and *Owner*. **Create project** saves it and goes
  back to the list, where a confirmation appears and the new project is highlighted.

### Fixed
- The status counts no longer flicker when the page loads.
