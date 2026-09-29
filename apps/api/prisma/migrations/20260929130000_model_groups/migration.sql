-- CreateEnum
CREATE TYPE "ModelGroupStatus" AS ENUM ('ENABLED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ModelOrigin" AS ENUM ('DOMESTIC', 'OVERSEAS');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "groupId" TEXT;

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "groupId" TEXT;

-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "region" "ModelOrigin",
ADD COLUMN     "upstreamGroup" TEXT;

-- AlterTable
ALTER TABLE "ChannelModel" ADD COLUMN     "upstreamModelName" TEXT;

-- AlterTable
ALTER TABLE "ModelCatalog" ADD COLUMN     "origin" "ModelOrigin" NOT NULL DEFAULT 'OVERSEAS',
ADD COLUMN     "vendor" TEXT;

-- AlterTable
ALTER TABLE "RequestLog" ADD COLUMN     "multiplierApplied" DECIMAL(6,4),
ADD COLUMN     "multiplierSource" TEXT;

-- CreateTable
CREATE TABLE "ModelGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "ratio" DECIMAL(6,4),
    "status" "ModelGroupStatus" NOT NULL DEFAULT 'ENABLED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ChannelGroups" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ChannelGroups_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ModelGroupModels" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ModelGroupModels_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelGroup_name_key" ON "ModelGroup"("name");

-- CreateIndex
CREATE INDEX "ModelGroup_status_priority_idx" ON "ModelGroup"("status", "priority");

-- CreateIndex
CREATE INDEX "_ChannelGroups_B_index" ON "_ChannelGroups"("B");

-- CreateIndex
CREATE INDEX "_ModelGroupModels_B_index" ON "_ModelGroupModels"("B");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ModelGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ModelGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ChannelGroups" ADD CONSTRAINT "_ChannelGroups_A_fkey" FOREIGN KEY ("A") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ChannelGroups" ADD CONSTRAINT "_ChannelGroups_B_fkey" FOREIGN KEY ("B") REFERENCES "ModelGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ModelGroupModels" ADD CONSTRAINT "_ModelGroupModels_A_fkey" FOREIGN KEY ("A") REFERENCES "ModelCatalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ModelGroupModels" ADD CONSTRAINT "_ModelGroupModels_B_fkey" FOREIGN KEY ("B") REFERENCES "ModelGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

