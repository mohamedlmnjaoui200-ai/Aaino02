-- شغّله مرة واحدة على قاعدة Azure SQL إن لم يملك مستخدم التطبيق صلاحية إنشاء الجداول
IF OBJECT_ID('dbo.KbChunks','U') IS NULL
CREATE TABLE dbo.KbChunks(
  ChunkId BIGINT IDENTITY(1,1) PRIMARY KEY,
  Source NVARCHAR(20) NOT NULL,            -- web | chat | verified | manual | import
  OwnerTelegramId BIGINT NULL,             -- NULL = معرفة عامة، وإلا خاصة بهذا المستخدم
  Title NVARCHAR(300) NOT NULL,
  BodyText NVARCHAR(MAX) NOT NULL,
  SearchText NVARCHAR(MAX) NOT NULL,       -- كلمات مطبّعة مسبقًا ومحاطة بمسافات
  Url NVARCHAR(1000) NULL,
  ContentHash CHAR(40) NOT NULL,
  CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_KbChunks_Hash' AND object_id=OBJECT_ID('dbo.KbChunks'))
CREATE UNIQUE INDEX UX_KbChunks_Hash ON dbo.KbChunks(ContentHash, OwnerTelegramId);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_KbChunks_Owner' AND object_id=OBJECT_ID('dbo.KbChunks'))
CREATE INDEX IX_KbChunks_Owner ON dbo.KbChunks(OwnerTelegramId, ChunkId DESC);

IF OBJECT_ID('dbo.KbFeedback','U') IS NULL
CREATE TABLE dbo.KbFeedback(
  FeedbackId BIGINT IDENTITY(1,1) PRIMARY KEY,
  TelegramId BIGINT NOT NULL,
  ConversationId BIGINT NULL,
  Question NVARCHAR(MAX) NOT NULL,
  Answer NVARCHAR(MAX) NOT NULL,
  Rating SMALLINT NOT NULL,
  CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
