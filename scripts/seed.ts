import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { Lane } from "../src/generated/prisma/enums.ts";

const SAMPLE: Array<{
  name: string;
  cards: Array<{ lane: keyof typeof Lane; title: string }>;
}> = [
  {
    name: "Overboard Organizer",
    cards: [
      { lane: "DONE", title: "Auth + session shell" },
      { lane: "DOING", title: "Board read-only render" },
      { lane: "TODO", title: "Card CRUD + TipTap editor drawer" },
      { lane: "TODO", title: "Drag-and-drop with dnd-kit" },
      { lane: "BACKLOG", title: "Idea Pool page + promote action" },
      { lane: "BACKLOG", title: "Docker + Caddy deploy + nightly backups" },
    ],
  },
  {
    name: "Home server",
    cards: [
      { lane: "BACKLOG", title: "Pick UPS for the old laptop" },
      { lane: "BACKLOG", title: "Cable management redo" },
      { lane: "TODO", title: "Set up nightly off-site rsync" },
    ],
  },
  {
    name: "Reading list",
    cards: [
      { lane: "DONE", title: "Designing Data-Intensive Applications" },
      { lane: "DOING", title: "Crafting Interpreters" },
      { lane: "TODO", title: "The Annotated Turing" },
      { lane: "BACKLOG", title: "Concrete Mathematics" },
    ],
  },
];

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("usage: npm run seed -- <email>");
    process.exit(1);
  }

  const url = process.env.DATABASE_URL?.replace(/^file:/, "") ?? "./data/app.db";
  const adapter = new PrismaBetterSqlite3({ url });
  const db = new PrismaClient({ adapter });

  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`no user with email ${email} — register first at /register`);
    process.exit(1);
  }

  // Wipe existing projects for this user (cascade removes cards)
  const wiped = await db.project.deleteMany({ where: { userId: user.id } });
  console.log(`cleared ${wiped.count} existing project(s)`);

  for (let i = 0; i < SAMPLE.length; i++) {
    const sample = SAMPLE[i];
    const project = await db.project.create({
      data: {
        userId: user.id,
        name: sample.name,
        order: i,
      },
    });

    const laneCounts: Record<string, number> = {
      BACKLOG: 0,
      TODO: 0,
      DOING: 0,
      DONE: 0,
    };

    for (const card of sample.cards) {
      await db.card.create({
        data: {
          projectId: project.id,
          lane: Lane[card.lane],
          order: laneCounts[card.lane]++,
          title: card.title,
        },
      });
    }
    console.log(`+ ${sample.name} (${sample.cards.length} cards)`);
  }

  console.log("done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
