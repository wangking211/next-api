-- CreateEnum
CREATE TYPE "RedeemCodeStatus" AS ENUM ('UNUSED', 'USED', 'DISABLED');

-- CreateTable
CREATE TABLE "RedeemCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "status" "RedeemCodeStatus" NOT NULL DEFAULT 'UNUSED',
    "batchId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "usedById" TEXT,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RedeemCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RedeemCode_code_key" ON "RedeemCode"("code");

-- CreateIndex
CREATE INDEX "RedeemCode_status_createdAt_idx" ON "RedeemCode"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RedeemCode_batchId_idx" ON "RedeemCode"("batchId");
