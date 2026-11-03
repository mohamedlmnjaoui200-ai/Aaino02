-- شغّله مرة واحدة على قاعدة Azure SQL (Query editor في بوابة Azure)
-- ثم شغّل sql/kb-schema.sql (أو اتركه يُنشأ تلقائياً عند الإقلاع)
IF OBJECT_ID('dbo.Users','U') IS NULL
CREATE TABLE dbo.Users(
  TelegramId BIGINT NOT NULL PRIMARY KEY,
  Username NVARCHAR(100) NULL, FirstName NVARCHAR(150) NULL, LastName NVARCHAR(150) NULL,
  IsAllowed BIT NOT NULL DEFAULT 0, InvitedAt DATETIME2 NULL,
  CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), LastSeenAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME());

IF OBJECT_ID('dbo.Invites','U') IS NULL
CREATE TABLE dbo.Invites(
  InviteId BIGINT IDENTITY(1,1) PRIMARY KEY, CodeHash VARCHAR(64) NOT NULL UNIQUE,
  CreatedBy BIGINT NOT NULL, MaxUses INT NOT NULL, UsesCount INT NOT NULL DEFAULT 0,
  ExpiresAt DATETIME2 NOT NULL, IsRevoked BIT NOT NULL DEFAULT 0,
  CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME());

IF OBJECT_ID('dbo.Conversations','U') IS NULL
CREATE TABLE dbo.Conversations(
  ConversationId BIGINT IDENTITY(1,1) PRIMARY KEY, TelegramId BIGINT NOT NULL,
  Title NVARCHAR(180) NOT NULL, IsDeleted BIT NOT NULL DEFAULT 0,
  CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME());

IF OBJECT_ID('dbo.Messages','U') IS NULL
CREATE TABLE dbo.Messages(
  MessageId BIGINT IDENTITY(1,1) PRIMARY KEY, ConversationId BIGINT NOT NULL,
  Role VARCHAR(20) NOT NULL, Content NVARCHAR(MAX) NOT NULL,
  CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME());

IF OBJECT_ID('dbo.CodeSnippets','U') IS NULL
CREATE TABLE dbo.CodeSnippets(
  SnippetId BIGINT IDENTITY(1,1) PRIMARY KEY, Language NVARCHAR(40) NULL,
  BodyText NVARCHAR(MAX) NULL, SearchText NVARCHAR(MAX) NULL,
  IsApproved BIT NOT NULL DEFAULT 0, QualityScore INT NOT NULL DEFAULT 0,
  CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME());

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_Messages_Conv' AND object_id=OBJECT_ID('dbo.Messages'))
CREATE INDEX IX_Messages_Conv ON dbo.Messages(ConversationId, CreatedAt DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_Conv_User' AND object_id=OBJECT_ID('dbo.Conversations'))
CREATE INDEX IX_Conv_User ON dbo.Conversations(TelegramId, UpdatedAt DESC);
