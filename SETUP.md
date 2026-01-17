# Discord Bot Setup Guide

## Prerequisites
- Node.js 18+ installed
- Discord bot created on Discord Developer Portal
- Discord server with appropriate roles

## Discord Setup

### 1. Create Discord Roles
Create these roles in your Discord server (exact names required):

**Nationalities:**
- Kharsovian_Republic
- Meridian_Federation
- Khorasan_Covenant

**Ranks (in order):**
- Private
- Sergeant
- Lieutenant
- Captain
- General
- Politician
- Head_of_State

### 2. Create Discord Bot
1. Go to https://discord.com/developers/applications
2. Click "New Application"
3. Go to "Bot" tab, click "Add Bot"
4. Enable these Privileged Gateway Intents:
   - Server Members Intent
   - Presence Intent
5. Copy the bot token

### 3. Get IDs
- **Client ID**: From application page (General Information)
- **Guild ID**: Right-click your Discord server → Copy ID (enable Developer Mode in Discord settings)

### 4. Invite Bot to Server
Use this URL (replace CLIENT_ID):
```
https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&permissions=268435456&scope=bot%20applications.commands
```

## Bot Installation

### 1. Install Dependencies
```bash
cd discord-bot
npm install
```

### 2. Configure Bot
Edit `bot.js` and set:
```javascript
const CONFIG = {
    TOKEN: 'your_bot_token_here',
    CLIENT_ID: 'your_client_id_here',
    GUILD_ID: 'your_guild_id_here',
    DATA_FILE: path.join(__dirname, 'player_data.json'),
    WAR_FILE: path.join(__dirname, 'war_state.json'),
    HTTP_PORT: 3000
};
```

### 3. Run Bot
```bash
npm start
```

Bot will:
- Start Discord bot
- Register slash commands
- Start HTTP API on port 3000
- Create `player_data.json` and `war_state.json`

## Discord Commands

### Admin Commands
- `/setnationality <player> <nationality>` - Assign nationality to player
- `/setrank <player> <rank>` - Assign rank to player
- `/sync` - Sync all players from Discord roles

### Player Commands (Everyone)
- `/choosenationality <nationality>` - Choose your nationality (everyone can use)
  - If you don't have a rank, you'll be automatically assigned Private rank
  - You can change your nationality anytime
- `/linkidentity <identityid>` - Link your Game Identity ID (required to play!)
  - Get your ID in-game when you spawn (shows in console and notification)
  - Example: `/linkidentity ABC123XYZ456DEF789`
- `/myinfo` - Check your full info (nationality, rank, Game Identity ID)
- `/playerinfo <player>` - Check another player's info
- `/warstatus` - Check detailed war status and in-game effects
- `/leaderboard` - View all players organized by nation and rank

### Head of State Commands (Rank: Head_of_State Only)
- `/declarewar <target1> [target2] [target3]` - Declare war against other nations
  - Can declare war on 1-3 nations simultaneously
  - Cannot declare war on your own nation (automatically filtered)
  - Duplicate selections are automatically removed
  - **Can expand existing wars**: If already at war, this adds new nations to the war
  - Enables POI capture & PvP
  - Examples:
    - Start new war: `/declarewar target1:Meridian_Federation`
    - Start war with multiple nations: `/declarewar target1:Meridian_Federation target2:Khorasan_Covenant`
    - Expand existing war: `/declarewar target1:Khorasan_Covenant` (adds to current war)
- `/declarepeace <target1> [target2] [target3]` - Make peace with specific nations
  - Must specify which nation(s) to make peace with
  - Can make peace with 1-3 nations at once
  - If all enemy nations removed, war ends completely (POI capture disabled)
  - If some enemies remain, war continues (POI capture stays enabled)
  - Examples:
    - Single peace: `/declarepeace target1:Meridian_Federation`
    - Multiple peace: `/declarepeace target1:Meridian_Federation target2:Khorasan_Covenant`

## HTTP API Endpoints

The bot exposes these endpoints for the game server:

- `GET /api/player/:steamId` - Get player data by Steam ID
- `GET /api/players` - Get all players
- `GET /api/war` - Get current war state

## Example API Response

**GET /api/player/ABC123XYZ456DEF789**
```json
{
  "discordId": "123456789",
  "username": "PlayerName",
  "nationality": "Kharsovian_Republic",
  "rank": "Captain",
  "steamId": "ABC123XYZ456DEF789"
}
```

*Note: The `steamId` field stores the Game Identity ID for backward compatibility*

**GET /api/war**
```json
{
  "active": true,
  "declaredBy": "PlayerName",
  "declaredAt": "2026-01-05T12:00:00.000Z",
  "declaredByNation": "Kharsovian_Republic",
  "targetNations": ["Meridian_Federation"],
  "participants": ["Kharsovian_Republic", "Meridian_Federation"]
}
```

## Security Notes

- Keep bot token secret
- Players can choose their own nationality (anyone can use `/choosenationality`)
- Only admins can set ranks with `/setrank`
- Only Heads of State can declare war/peace
- API has no authentication (intended for localhost/private network)

## Troubleshooting

**Bot not responding to commands:**
- Check bot has proper permissions
- Verify GUILD_ID is correct
- Ensure bot is online

**Player data not syncing:**
- Run `/sync` command
- Check roles are named exactly as defined (case-sensitive)

**Player doesn't know their Game Identity ID:**
- Tell them to join the game server and spawn
- The ID will be shown in console and as a notification
- They can also press ESC (pause menu) to see it

**API not accessible:**
- Check port 3000 is not blocked
- Verify bot is running
