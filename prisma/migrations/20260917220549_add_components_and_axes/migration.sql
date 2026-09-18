-- CreateTable
CREATE TABLE "Axis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Axis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Component" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "axisId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "contentJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Component_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Component_axisId_fkey" FOREIGN KEY ("axisId") REFERENCES "Axis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConceptAxis" (
    "ideaId" TEXT NOT NULL,
    "axisId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("ideaId", "axisId"),
    CONSTRAINT "ConceptAxis_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConceptAxis_axisId_fkey" FOREIGN KEY ("axisId") REFERENCES "Axis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConceptComponent" (
    "ideaId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("ideaId", "componentId"),
    CONSTRAINT "ConceptComponent_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConceptComponent_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Component" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Axis_userId_idx" ON "Axis"("userId");

-- CreateIndex
CREATE INDEX "Axis_userId_order_idx" ON "Axis"("userId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "Axis_userId_name_key" ON "Axis"("userId", "name");

-- CreateIndex
CREATE INDEX "Component_userId_idx" ON "Component"("userId");

-- CreateIndex
CREATE INDEX "Component_axisId_idx" ON "Component"("axisId");

-- CreateIndex
CREATE UNIQUE INDEX "Component_userId_name_key" ON "Component"("userId", "name");

-- CreateIndex
CREATE INDEX "ConceptAxis_axisId_idx" ON "ConceptAxis"("axisId");

-- CreateIndex
CREATE INDEX "ConceptComponent_componentId_idx" ON "ConceptComponent"("componentId");
