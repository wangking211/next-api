-- AlterTable
ALTER TABLE "ChannelModel" ADD COLUMN     "costPerCall" DECIMAL(18,6),
ADD COLUMN     "pricePerCall" DECIMAL(18,6);

-- AlterTable
ALTER TABLE "ModelCatalog" ADD COLUMN     "perCallPrice" DECIMAL(18,6);

