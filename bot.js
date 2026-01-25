const { Client, GatewayIntentBits, PermissionFlagsBits, SlashCommandBuilder, REST, Routes, AttachmentBuilder } = require('discord.js');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');

// Load environment variables from .env file if it exists
require('dotenv').config();

// Configuration - secrets loaded from environment variables
const CONFIG = {
    TOKEN: process.env.DISCORD_TOKEN,
    CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    GUILD_ID: process.env.DISCORD_GUILD_ID,
    DATA_FILE: path.join(__dirname, 'player_data.json'),
    WAR_FILE: path.join(__dirname, 'war_state.json'),
    TERRITORY_FILE: path.join(__dirname, 'territory_data.json'),
    HTTP_PORT: process.env.HTTP_PORT || 3000,
    // Game sync directory (copy JSON files here for game to read)
    GAME_SYNC_DIR: process.env.GAME_SYNC_DIR || path.join(__dirname, 'game_data'),
    // Territory map settings
    TERRITORY_CHANNEL_NAME: '『🗺️』live-territory-map',
    TERRITORY_UPDATE_INTERVAL: 30000 // Update every 30 seconds
};

// Nationality and Rank definitions
const NATIONALITIES = ['USSR', 'US', 'FIA'];
const RANKS = ['Private', 'Sergeant', 'Lieutenant', 'Captain', 'General', 'Politician', 'Head_of_State'];

// Channel mapping for nationality-restricted channels
// Map nationality roles to their private channel names (with emoji prefixes)
const NATIONALITY_CHANNELS = {
    'USSR': [
        '『ℹ️』ussr-info',
        '『📢』ussr-talk',
        '『💬』chat',
        '『🔊』Voice Chat',
        '『🔴』National Gathering'
    ],
    'US': [
        '『ℹ️』us-info',
        '『📢』us-news',
        '『💬』chat',
        '『🔊』Voice Chat',
        '『📺』TV Station'
    ],
    'FIA': [
        '『ℹ️』fia-info',
        '『📢』fia-liberty',
        '『💬』chat',
        '『🔊』Voice Chat',
        '『📰』News Channel'
    ]
};

// War state storage
let warState = {
    active: false,
    declaredBy: null,
    declaredAt: null,
    declaredByNation: null,
    targetNations: [], // Array of nations being declared war on
    participants: [] // All nations involved (declarer + targets)
};

// Player data storage {discordId: {nationality, rank, steamId}}
let playerData = {};

// Territory data storage
let territoryData = {
    bases: [],
    lastUpdate: null
};

// Territory map message ID (for editing instead of creating new)
let territoryMessageId = null;

// Load data
function loadData() {
    try {
        if (fs.existsSync(CONFIG.DATA_FILE)) {
            playerData = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
        }
        if (fs.existsSync(CONFIG.WAR_FILE)) {
            warState = JSON.parse(fs.readFileSync(CONFIG.WAR_FILE, 'utf8'));
        }
        if (fs.existsSync(CONFIG.TERRITORY_FILE)) {
            territoryData = JSON.parse(fs.readFileSync(CONFIG.TERRITORY_FILE, 'utf8'));
        }
    } catch (err) {
        console.error('Error loading data:', err);
    }
}

// Save data
function saveData() {
    try {
        fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(playerData, null, 2));
        fs.writeFileSync(CONFIG.WAR_FILE, JSON.stringify(warState, null, 2));

        // Also copy to game sync directory
        if (CONFIG.GAME_SYNC_DIR) {
            if (!fs.existsSync(CONFIG.GAME_SYNC_DIR)) {
                fs.mkdirSync(CONFIG.GAME_SYNC_DIR, { recursive: true });
            }
            fs.writeFileSync(path.join(CONFIG.GAME_SYNC_DIR, 'player_data.json'), JSON.stringify(playerData, null, 2));
            fs.writeFileSync(path.join(CONFIG.GAME_SYNC_DIR, 'war_state.json'), JSON.stringify(warState, null, 2));
            console.log('Synced data to game directory');
        }
    } catch (err) {
        console.error('Error saving data:', err);
    }
}

// Get player data from Discord roles
function getPlayerDataFromMember(member) {
    const nationality = NATIONALITIES.find(n =>
        member.roles.cache.some(role => role.name === n)
    ) || 'USSR'; // Default to USSR

    const rank = RANKS.find(r =>
        member.roles.cache.some(role => role.name === r)
    ) || 'Private'; // Default to Private

    return { nationality, rank };
}

// Sync channel permissions for nationality-restricted channels
async function syncChannelPermissions(guild) {
    console.log('Syncing channel permissions for nationality-restricted channels...');

    try {
        // Check if bot has necessary permissions
        const botMember = guild.members.cache.get(client.user.id);
        if (!botMember) {
            console.error('Could not find bot member in guild!');
            return;
        }

        if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
            console.error('⚠️ Bot is missing "Manage Channels" permission!');
            console.error('Please grant the bot "Manage Channels" permission in Server Settings → Roles');
            return;
        }

        // Get all nationality roles
        const nationalityRoles = {};
        for (const nat of NATIONALITIES) {
            const role = guild.roles.cache.find(r => r.name === nat);
            if (role) {
                nationalityRoles[nat] = role;
            } else {
                console.warn(`Warning: Role ${nat} not found!`);
            }
        }

        // For each nationality, configure their private channels
        for (const [nationality, channelNames] of Object.entries(NATIONALITY_CHANNELS)) {
            const role = nationalityRoles[nationality];
            if (!role) continue;

            console.log(`Configuring channels for ${nationality}...`);

            for (const channelName of channelNames) {
                // Find channel (exact match with emoji)
                const channel = guild.channels.cache.find(ch =>
                    ch.name === channelName
                );

                if (!channel) {
                    console.warn(`  Channel "${channelName}" not found!`);
                    continue;
                }

                // Check if bot can manage this specific channel
                const channelPermissions = channel.permissionsFor(botMember);
                if (!channelPermissions || !channelPermissions.has(PermissionFlagsBits.ManageChannels)) {
                    console.warn(`  ⚠️ Bot cannot manage channel "${channelName}" (missing permissions or role hierarchy issue)`);
                    continue;
                }

                try {
                    // Set permissions
                    await channel.permissionOverwrites.set([
                        {
                            // Deny @everyone (hide from everyone by default)
                            id: guild.roles.everyone,
                            deny: [PermissionFlagsBits.ViewChannel]
                        },
                        {
                            // Allow only this nationality role to see the channel
                            id: role.id,
                            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
                        }
                    ]);

                    console.log(`  ✅ Configured ${channelName} for ${nationality}`);
                } catch (channelError) {
                    console.error(`  ❌ Failed to configure ${channelName}:`, channelError.message);
                }
            }
        }

        console.log('Channel permissions sync completed!');
    } catch (error) {
        console.error('Error syncing channel permissions:', error.message);
    }
}

// Sync all players
function syncAllPlayers(guild) {
    guild.members.fetch().then(members => {
        members.forEach(member => {
            if (member.user.bot) return;

            const data = getPlayerDataFromMember(member);
            playerData[member.id] = {
                discordId: member.id,
                username: member.user.username,
                nationality: data.nationality,
                rank: data.rank,
                steamId: playerData[member.id]?.steamId || null
            };
        });
        saveData();
        console.log(`Synced ${Object.keys(playerData).length} players`);
    });
}

//------------------------------------------------------------------------------------------------
// Convex Hull algorithm (Graham Scan) for drawing faction borders
function convexHull(points) {
    if (points.length < 3) return points;

    // Sort points by x, then by y
    const sorted = points.slice().sort((a, b) => {
        if (a.x === b.x) return a.y - b.y;
        return a.x - b.x;
    });

    // Cross product to determine turn direction
    const cross = (o, a, b) => {
        return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    };

    // Build lower hull
    const lower = [];
    for (const point of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
            lower.pop();
        }
        lower.push(point);
    }

    // Build upper hull
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        const point = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
            upper.pop();
        }
        upper.push(point);
    }

    // Remove last point of each half because it's repeated
    lower.pop();
    upper.pop();

    return lower.concat(upper);
}

//------------------------------------------------------------------------------------------------
// Update territory map in Discord channel
// Generate visual map image
async function generateMapImage(bases) {
    // Find min/max coordinates to determine map bounds
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (const base of bases) {
        if (base.x && base.z) {
            minX = Math.min(minX, base.x);
            maxX = Math.max(maxX, base.x);
            minZ = Math.min(minZ, base.z);
            maxZ = Math.max(maxZ, base.z);
        }
    }

    console.log(`Map coordinate ranges: X: ${minX} to ${maxX}, Z: ${minZ} to ${maxZ}`);

    // Map dimensions (Everon is 12.8km x 12.8km, from 0 to 12800)
    const MAP_SIZE = 12800;
    const CANVAS_SIZE = 1200;
    const SCALE = CANVAS_SIZE / MAP_SIZE;

    const canvas = createCanvas(CANVAS_SIZE, CANVAS_SIZE);
    const ctx = canvas.getContext('2d');

    // Load and draw background image
    const bgPath = path.join(__dirname, 'mapbg.png');
    if (fs.existsSync(bgPath)) {
        try {
            const bgImage = await loadImage(bgPath);
            ctx.drawImage(bgImage, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
        } catch (err) {
            console.error('Error loading map background:', err.message);
            // Fallback to dark background
            ctx.fillStyle = '#1a1a1a';
            ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
        }
    } else {
        // Fallback to dark background
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    }

    // Grid is disabled when using custom map background
    // (uncomment if you want grid lines over the map)
    /*
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 1;
    const gridSize = CANVAS_SIZE / 16; // 16x16 grid
    for (let i = 0; i <= 16; i++) {
        const pos = i * gridSize;
        ctx.beginPath();
        ctx.moveTo(pos, 0);
        ctx.lineTo(pos, CANVAS_SIZE);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, pos);
        ctx.lineTo(CANVAS_SIZE, pos);
        ctx.stroke();
    }
    */

    // Faction colors
    const factionColors = {
        'US': { color: '#3498db', name: 'Meridian Federation', borderColor: '#2980b9' },      // Blue
        'USSR': { color: '#e74c3c', name: 'Kharsovian Republic', borderColor: '#c0392b' },      // Red
        'FIA': { color: '#2ecc71', name: 'Khorasan Covenant', borderColor: '#27ae60' },       // Green
        'Neutral': { color: '#95a5a6', name: 'Neutral', borderColor: '#7f8c8d' }     // Gray
    };

    // Group bases by faction for border drawing
    const factionBases = {
        'US': [],
        'USSR': [],
        'FIA': []
    };

    // Collect and convert base positions
    const basePositions = [];
    if (bases && bases.length > 0) {
        for (const base of bases) {
            if (!base.x || !base.z) continue;

            // Convert game coordinates to canvas coordinates
            // Flip only Z axis (vertical)
            const x = base.x * SCALE;
            const y = (MAP_SIZE - base.z) * SCALE;

            const baseData = {
                ...base,
                canvasX: x,
                canvasY: y
            };
            basePositions.push(baseData);

            // Group by faction for border drawing (exclude neutral and HQs)
            if (base.faction !== 'Neutral' && base.type !== 'HQ' && factionBases[base.faction]) {
                factionBases[base.faction].push({ x, y });
            }
        }
    }

    // Draw faction borders using convex hull
    for (const [faction, points] of Object.entries(factionBases)) {
        if (points.length < 3) continue; // Need at least 3 points for a border

        const hull = convexHull(points);
        if (hull.length < 3) continue;

        const factionInfo = factionColors[faction];

        // Draw border
        ctx.strokeStyle = factionInfo.borderColor;
        ctx.lineWidth = 4;
        ctx.setLineDash([10, 5]);
        ctx.globalAlpha = 0.7;

        ctx.beginPath();
        ctx.moveTo(hull[0].x, hull[0].y);
        for (let i = 1; i < hull.length; i++) {
            ctx.lineTo(hull[i].x, hull[i].y);
        }
        ctx.closePath();
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.globalAlpha = 1.0;
    }

    // Draw base markers and labels
    for (const base of basePositions) {
        const factionInfo = factionColors[base.faction] || factionColors['Neutral'];

        // Draw base marker
        ctx.fillStyle = factionInfo.color;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;

        // Different shapes for different types
        if (base.type === 'HQ') {
            // HQ: Large star
            drawStar(ctx, base.canvasX, base.canvasY, 5, 20, 10);
        } else if (base.type === 'POI') {
            // POI: Diamond
            drawDiamond(ctx, base.canvasX, base.canvasY, 16);
        } else {
            // FOB: Circle
            ctx.beginPath();
            ctx.arc(base.canvasX, base.canvasY, 10, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        // Draw base name with shadow
        const baseName = base.name || 'Unknown';
        ctx.font = 'bold 14px Arial';
        ctx.textAlign = 'center';

        // Shadow/outline for contrast
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 3;
        ctx.strokeText(baseName, base.canvasX, base.canvasY - 25);

        // Text
        ctx.fillStyle = '#ffffff';
        ctx.fillText(baseName, base.canvasX, base.canvasY - 25);
    }

    // Draw legend
    const legendX = 80;
    const legendY = CANVAS_SIZE - 180;

    // Legend background - wider to fit both sections
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(legendX - 60, legendY - 10, 450, 170);

    // Legend title
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px Arial';
    ctx.fillText('FACTIONS', legendX, legendY + 10);

    // Legend entries
    ctx.font = '14px Arial';
    let yOffset = 35;
    for (const [key, info] of Object.entries(factionColors)) {
        ctx.fillStyle = info.color;
        ctx.beginPath();
        ctx.arc(legendX + 10, legendY + yOffset, 8, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.fillText(info.name, legendX + 60, legendY + yOffset + 5);
        yOffset += 30;
    }

    // Shape legend
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px Arial';
    ctx.fillText('TYPES', legendX + 250, legendY + 10);

    ctx.font = '14px Arial';
    ctx.fillStyle = '#3498db';

    // HQ marker
    drawStar(ctx, legendX + 260, legendY + 35, 5, 15, 7);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('HQ', legendX + 290, legendY + 40);

    // POI marker
    ctx.fillStyle = '#3498db';
    drawDiamond(ctx, legendX + 260, legendY + 65, 12);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('POI', legendX + 290, legendY + 70);

    // FOB marker
    ctx.fillStyle = '#3498db';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(legendX + 260, legendY + 95, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillText('FOB', legendX + 290, legendY + 100);

    return canvas.toBuffer('image/png');
}

// Helper function to draw a star
function drawStar(ctx, x, y, points, outerRadius, innerRadius) {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
        const radius = i % 2 === 0 ? outerRadius : innerRadius;
        const angle = (i * Math.PI) / points - Math.PI / 2;
        const px = x + Math.cos(angle) * radius;
        const py = y + Math.sin(angle) * radius;
        if (i === 0) {
            ctx.moveTo(px, py);
        } else {
            ctx.lineTo(px, py);
        }
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
}

// Helper function to draw a diamond
function drawDiamond(ctx, x, y, size) {
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.lineTo(x + size, y);
    ctx.lineTo(x, y + size);
    ctx.lineTo(x - size, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
}

async function updateTerritoryMap(guild) {
    try {
        // Find or create the territory channel
        let channel = guild.channels.cache.find(ch => ch.name === CONFIG.TERRITORY_CHANNEL_NAME);

        if (!channel) {
            console.log(`Territory channel "${CONFIG.TERRITORY_CHANNEL_NAME}" not found - skipping update`);
            return;
        }

        // Reload territory data
        if (fs.existsSync(CONFIG.TERRITORY_FILE)) {
            territoryData = JSON.parse(fs.readFileSync(CONFIG.TERRITORY_FILE, 'utf8'));
        }

        // Create the embed
        const { EmbedBuilder } = require('discord.js');
        const embed = new EmbedBuilder()
            .setTitle('🗺️ Live Territory Control')
            .setColor('#5865F2')
            .setTimestamp();

        if (warState.active) {
            embed.setDescription(`⚔️ **WAR ACTIVE**\nDeclared by: ${warState.declaredBy || 'Unknown'}`);
        } else {
            embed.setDescription(`☮️ **PEACE TIME**\nBase capture is disabled`);
        }

        // Group bases by faction
        const factionBases = {
            'US': { name: 'Meridian Federation 🔵', bases: [], hq: [], fobs: [], pois: [] },
            'USSR': { name: 'Kharsovian Republic 🔴', bases: [], hq: [], fobs: [], pois: [] },
            'FIA': { name: 'Khorasan Covenant 🟢', bases: [], hq: [], fobs: [], pois: [] },
            'Neutral': { name: 'Neutral ⚪', bases: [], hq: [], fobs: [], pois: [] }
        };

        if (territoryData.bases && territoryData.bases.length > 0) {
            // Categorize bases
            for (const base of territoryData.bases) {
                const faction = base.faction || 'Neutral';
                const factionData = factionBases[faction] || factionBases['Neutral'];

                if (base.type === 'HQ') {
                    factionData.hq.push(base);
                } else if (base.type === 'FOB') {
                    factionData.fobs.push(base);
                } else if (base.type === 'POI') {
                    factionData.pois.push(base);
                }
            }

            // Add fields for each faction
            for (const [factionKey, data] of Object.entries(factionBases)) {
                const totalBases = data.hq.length + data.fobs.length + data.pois.length;

                if (totalBases === 0) continue;

                let fieldValue = '';

                // HQs
                if (data.hq.length > 0) {
                    fieldValue += `**HQ (${data.hq.length}):** ${data.hq.map(b => b.name).join(', ')}\n`;
                }

                // FOBs
                if (data.fobs.length > 0) {
                    fieldValue += `**FOBs (${data.fobs.length}):** ${data.fobs.map(b => b.name).join(', ')}\n`;
                }

                // POIs
                if (data.pois.length > 0) {
                    const poiGroups = {};
                    for (const poi of data.pois) {
                        const type = poi.poiType || 'Other';
                        if (!poiGroups[type]) poiGroups[type] = [];
                        poiGroups[type].push(poi.name);
                    }

                    for (const [type, names] of Object.entries(poiGroups)) {
                        fieldValue += `**${type}s (${names.length}):** ${names.join(', ')}\n`;
                    }
                }

                embed.addFields({
                    name: `${data.name} - ${totalBases} bases`,
                    value: fieldValue || 'No bases',
                    inline: false
                });
            }
        } else {
            embed.addFields({
                name: 'No Data',
                value: 'Waiting for game server to send territory data...',
                inline: false
            });
        }

        // Update timestamp
        if (territoryData.lastUpdate) {
            embed.setFooter({ text: `Last updated from game server` });
        } else {
            embed.setFooter({ text: 'No updates received yet' });
        }

        // Generate map image
        let attachment = null;
        if (territoryData.bases && territoryData.bases.length > 0) {
            try {
                const imageBuffer = await generateMapImage(territoryData.bases);
                attachment = new AttachmentBuilder(imageBuffer, { name: 'territory-map.png' });
                embed.setImage('attachment://territory-map.png');
            } catch (err) {
                console.error('Error generating map image:', err.message);
            }
        }

        // Send or update the message
        const messageOptions = { embeds: [embed] };
        if (attachment) {
            messageOptions.files = [attachment];
        }

        try {
            if (territoryMessageId) {
                // Delete old message
                try {
                    const oldMessage = await channel.messages.fetch(territoryMessageId);
                    await oldMessage.delete();
                } catch (err) {
                    // Message already deleted or doesn't exist, ignore
                }
            }

            // Send new message
            const message = await channel.send(messageOptions);
            territoryMessageId = message.id;
        } catch (error) {
            console.error('Error sending territory map:', error.message);
        }

    } catch (error) {
        console.error('Error updating territory map:', error.message);
    }
}

// Discord bot setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    loadData();

    // Get guild and ensure roles exist
    const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
    if (guild) {
        try {
            await ensureRolesExist(guild);
        } catch (error) {
            console.error('Failed to auto-create roles (Missing Permissions)');
            console.error('Please manually create these roles OR grant bot "Manage Roles" permission:');
            console.error('Nationalities (Blue):', NATIONALITIES.join(', '));
            console.error('Ranks (Green):', RANKS.join(', '));
        }

        // Sync channel permissions for nationality-restricted channels
        await syncChannelPermissions(guild);

        syncAllPlayers(guild);

        // Start territory map updates
        console.log('Starting territory map updates...');
        updateTerritoryMap(guild); // Initial update
        setInterval(() => updateTerritoryMap(guild), CONFIG.TERRITORY_UPDATE_INTERVAL);
    }
});

//------------------------------------------------------------------------------------------------
// Ensure all required roles exist
async function ensureRolesExist(guild) {
    console.log('Checking if all required roles exist...');

    // Check nationalities
    for (const nat of NATIONALITIES) {
        const role = guild.roles.cache.find(r => r.name === nat);
        if (!role) {
            console.log(`Creating nationality role: ${nat}`);
            await guild.roles.create({
                name: nat,
                color: 'Blue',
                reason: 'Auto-created by Discord bot'
            });
        }
    }

    // Check ranks
    for (const rank of RANKS) {
        const role = guild.roles.cache.find(r => r.name === rank);
        if (!role) {
            console.log(`Creating rank role: ${rank}`);
            await guild.roles.create({
                name: rank,
                color: 'Green',
                reason: 'Auto-created by Discord bot'
            });
        }
    }

    console.log('All required roles verified/created!');
}

// Commands
const commands = [
    new SlashCommandBuilder()
        .setName('setnationality')
        .setDescription('Set player nationality (Admin only)')
        .addUserOption(option =>
            option.setName('player')
                .setDescription('Player to set nationality for')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('nationality')
                .setDescription('Nationality')
                .setRequired(true)
                .addChoices(
                    ...NATIONALITIES.map(n => ({ name: n, value: n }))
                ))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('setrank')
        .setDescription('Set player rank (Admin only)')
        .addUserOption(option =>
            option.setName('player')
                .setDescription('Player to set rank for')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('rank')
                .setDescription('Rank')
                .setRequired(true)
                .addChoices(
                    ...RANKS.map(r => ({ name: r, value: r }))
                ))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('choosenationality')
        .setDescription('Choose your nationality (everyone can use)')
        .addStringOption(option =>
            option.setName('nationality')
                .setDescription('Your nationality')
                .setRequired(true)
                .addChoices(
                    ...NATIONALITIES.map(n => ({ name: n.replace(/_/g, ' '), value: n }))
                )),

    new SlashCommandBuilder()
        .setName('linkidentity')
        .setDescription('Link your Game Identity ID')
        .addStringOption(option =>
            option.setName('identityid')
                .setDescription('Your Game Identity ID (shown in-game when you spawn)')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('declarewar')
        .setDescription('Declare war (Head of State only)')
        .addStringOption(option =>
            option.setName('target1')
                .setDescription('First nation to declare war against')
                .setRequired(true)
                .addChoices(
                    ...NATIONALITIES.map(n => ({ name: n.replace(/_/g, ' '), value: n }))
                ))
        .addStringOption(option =>
            option.setName('target2')
                .setDescription('Second nation (optional)')
                .setRequired(false)
                .addChoices(
                    ...NATIONALITIES.map(n => ({ name: n.replace(/_/g, ' '), value: n }))
                ))
        .addStringOption(option =>
            option.setName('target3')
                .setDescription('Third nation (optional)')
                .setRequired(false)
                .addChoices(
                    ...NATIONALITIES.map(n => ({ name: n.replace(/_/g, ' '), value: n }))
                )),

    new SlashCommandBuilder()
        .setName('declarepeace')
        .setDescription('Declare peace with specific nations (Head of State only)')
        .addStringOption(option =>
            option.setName('target1')
                .setDescription('First nation to make peace with')
                .setRequired(true)
                .addChoices(
                    ...NATIONALITIES.map(n => ({ name: n.replace(/_/g, ' '), value: n }))
                ))
        .addStringOption(option =>
            option.setName('target2')
                .setDescription('Second nation (optional)')
                .setRequired(false)
                .addChoices(
                    ...NATIONALITIES.map(n => ({ name: n.replace(/_/g, ' '), value: n }))
                ))
        .addStringOption(option =>
            option.setName('target3')
                .setDescription('Third nation (optional)')
                .setRequired(false)
                .addChoices(
                    ...NATIONALITIES.map(n => ({ name: n.replace(/_/g, ' '), value: n }))
                )),

    new SlashCommandBuilder()
        .setName('myinfo')
        .setDescription('Check your nationality, rank, and Steam ID'),

    new SlashCommandBuilder()
        .setName('playerinfo')
        .setDescription('Check another player\'s info')
        .addUserOption(option =>
            option.setName('player')
                .setDescription('Player to check')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('warstatus')
        .setDescription('Check current war status and details'),

    new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Show all players by rank and nationality'),

    new SlashCommandBuilder()
        .setName('sync')
        .setDescription('Sync all players (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('syncchannels')
        .setDescription('Sync channel permissions for nationality-restricted channels (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

// Register commands
const rest = new REST({ version: '10' }).setToken(CONFIG.TOKEN);

(async () => {
    try {
        console.log('Registering slash commands...');
        await rest.put(
            Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID),
            { body: commands }
        );
        console.log('Slash commands registered');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
})();

// Command handler
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const member = interaction.member;

    try {
        switch (commandName) {
            case 'setnationality': {
                const targetUser = interaction.options.getUser('player');
                const nationality = interaction.options.getString('nationality');
                const targetMember = await interaction.guild.members.fetch(targetUser.id);

                // Add nationality role, remove old ones
                let roleAdded = false;
                for (const nat of NATIONALITIES) {
                    const role = interaction.guild.roles.cache.find(r => r.name === nat);
                    if (role) {
                        if (nat === nationality) {
                            await targetMember.roles.add(role);
                            roleAdded = true;
                            console.log(`Added ${nationality} role to ${targetUser.username}`);
                        } else {
                            await targetMember.roles.remove(role);
                        }
                    } else if (nat === nationality) {
                        console.warn(`WARNING: Role ${nationality} does not exist!`);
                        try {
                            console.log('Attempting to create role...');
                            const createdRole = await interaction.guild.roles.create({
                                name: nationality,
                                color: 'Blue',
                                reason: 'Auto-created when assigning to player'
                            });
                            await targetMember.roles.add(createdRole);
                            roleAdded = true;
                            console.log(`Successfully created and assigned role: ${nationality}`);
                        } catch (error) {
                            console.error('Failed to create role:', error.message);
                        }
                    }
                }

                // Update data
                if (!playerData[targetUser.id]) playerData[targetUser.id] = {};
                playerData[targetUser.id].nationality = nationality;
                playerData[targetUser.id].discordId = targetUser.id;
                playerData[targetUser.id].username = targetUser.username;

                // Get current rank from roles
                const currentData = getPlayerDataFromMember(targetMember);
                playerData[targetUser.id].rank = currentData.rank;

                saveData();

                await interaction.reply(`✅ Set ${targetUser.username}'s nationality to **${nationality.replace(/_/g, ' ')}**\nRole ${roleAdded ? 'applied' : 'not found (check server roles)'}`);
                break;
            }

            case 'setrank': {
                const targetUser = interaction.options.getUser('player');
                const rank = interaction.options.getString('rank');
                const targetMember = await interaction.guild.members.fetch(targetUser.id);

                // Add rank role, remove old ones
                let roleAdded = false;
                for (const r of RANKS) {
                    const role = interaction.guild.roles.cache.find(role => role.name === r);
                    if (role) {
                        if (r === rank) {
                            await targetMember.roles.add(role);
                            roleAdded = true;
                            console.log(`Added ${rank} role to ${targetUser.username}`);
                        } else {
                            await targetMember.roles.remove(role);
                        }
                    } else if (r === rank) {
                        console.warn(`WARNING: Role ${rank} does not exist!`);
                        try {
                            console.log('Attempting to create role...');
                            const createdRole = await interaction.guild.roles.create({
                                name: rank,
                                color: 'Green',
                                reason: 'Auto-created when assigning to player'
                            });
                            await targetMember.roles.add(createdRole);
                            roleAdded = true;
                            console.log(`Successfully created and assigned role: ${rank}`);
                        } catch (error) {
                            console.error('Failed to create role:', error.message);
                        }
                    }
                }

                // Update data
                if (!playerData[targetUser.id]) playerData[targetUser.id] = {};
                playerData[targetUser.id].rank = rank;
                playerData[targetUser.id].discordId = targetUser.id;
                playerData[targetUser.id].username = targetUser.username;

                // Get current nationality from roles
                const currentData = getPlayerDataFromMember(targetMember);
                playerData[targetUser.id].nationality = currentData.nationality;

                saveData();

                await interaction.reply(`✅ Set ${targetUser.username}'s rank to **${rank.replace(/_/g, ' ')}**\nRole ${roleAdded ? 'applied' : 'not found (check server roles)'}`);
                break;
            }

            case 'choosenationality': {
                const nationality = interaction.options.getString('nationality');

                // Add nationality role, remove old ones
                let roleAdded = false;
                for (const nat of NATIONALITIES) {
                    const role = interaction.guild.roles.cache.find(r => r.name === nat);
                    if (role) {
                        if (nat === nationality) {
                            await member.roles.add(role);
                            roleAdded = true;
                            console.log(`Added ${nationality} role to ${interaction.user.username}`);
                        } else {
                            await member.roles.remove(role);
                        }
                    } else if (nat === nationality) {
                        console.warn(`WARNING: Role ${nationality} does not exist!`);
                        try {
                            console.log('Attempting to create role...');
                            const createdRole = await interaction.guild.roles.create({
                                name: nationality,
                                color: 'Blue',
                                reason: 'Auto-created when player chose nationality'
                            });
                            await member.roles.add(createdRole);
                            roleAdded = true;
                            console.log(`Successfully created and assigned role: ${nationality}`);
                        } catch (error) {
                            console.error('Failed to create role:', error.message);
                        }
                    }
                }

                // Check if user has a rank, if not, assign Private
                const currentData = getPlayerDataFromMember(member);
                let rankAssigned = false;

                if (currentData.rank === 'Private' && !member.roles.cache.some(r => RANKS.includes(r.name))) {
                    // User has no rank role, assign Private
                    const privateRole = interaction.guild.roles.cache.find(r => r.name === 'Private');
                    if (privateRole) {
                        await member.roles.add(privateRole);
                        rankAssigned = true;
                        console.log(`Auto-assigned Private rank to ${interaction.user.username}`);
                    } else {
                        try {
                            const createdRole = await interaction.guild.roles.create({
                                name: 'Private',
                                color: 'Green',
                                reason: 'Auto-created when assigning default rank'
                            });
                            await member.roles.add(createdRole);
                            rankAssigned = true;
                            console.log(`Created and assigned Private rank to ${interaction.user.username}`);
                        } catch (error) {
                            console.error('Failed to create Private role:', error.message);
                        }
                    }
                }

                // Update data
                if (!playerData[member.id]) playerData[member.id] = {};
                playerData[member.id].nationality = nationality;
                playerData[member.id].rank = currentData.rank;
                playerData[member.id].discordId = member.id;
                playerData[member.id].username = interaction.user.username;

                saveData();

                let response = `✅ Set your nationality to **${nationality.replace(/_/g, ' ')}**\n`;
                if (roleAdded) {
                    response += `Nationality role applied!\n`;
                } else {
                    response += `⚠️ Nationality role not found on server\n`;
                }

                if (rankAssigned) {
                    response += `\n🎖️ You've been assigned the rank: **Private**\n`;
                    response += `*Admins can promote you later using /setrank*`;
                }

                await interaction.reply(response);
                break;
            }

            case 'linkidentity': {
                const identityId = interaction.options.getString('identityid');

                if (!playerData[member.id]) playerData[member.id] = {};
                playerData[member.id].steamId = identityId; // Keep 'steamId' key for compatibility
                playerData[member.id].discordId = member.id;
                playerData[member.id].username = interaction.user.username;

                const data = getPlayerDataFromMember(member);
                playerData[member.id].nationality = data.nationality;
                playerData[member.id].rank = data.rank;

                saveData();

                await interaction.reply(`✅ Linked Game Identity ID: ${identityId}\n\n**You're ready to play!**\nYou can spawn on ${data.nationality.replace(/_/g, ' ')} bases (${s_mNationalityToFaction ? 'checking faction...' : 'faction mapping pending'})`);
                break;
            }

            case 'declarewar': {
                const data = getPlayerDataFromMember(member);

                if (data.rank !== 'Head_of_State') {
                    await interaction.reply('Only Heads of State can declare war!');
                    return;
                }

                // Collect all target nations
                const target1 = interaction.options.getString('target1');
                const target2 = interaction.options.getString('target2');
                const target3 = interaction.options.getString('target3');

                let targetNations = [target1, target2, target3].filter(t => t !== null);

                // Remove duplicates
                targetNations = [...new Set(targetNations)];

                // Remove declaring nation if accidentally selected
                targetNations = targetNations.filter(t => t !== data.nationality);

                // Check if any valid targets remain
                if (targetNations.length === 0) {
                    await interaction.reply('❌ You cannot declare war on your own nation! Please select at least one other nation.');
                    return;
                }

                // If war is already active, add new nations to existing war
                if (warState.active) {
                    // Filter out nations already at war
                    const alreadyAtWar = targetNations.filter(t => warState.targetNations.includes(t));
                    const newTargets = targetNations.filter(t => !warState.targetNations.includes(t));

                    if (newTargets.length === 0) {
                        const alreadyAtWarDisplay = alreadyAtWar.map(n => n.replace(/_/g, ' ')).join(', ');
                        await interaction.reply(`❌ You are already at war with: ${alreadyAtWarDisplay}`);
                        return;
                    }

                    // Add new nations to war
                    warState.targetNations.push(...newTargets);
                    warState.participants.push(...newTargets);
                    saveData();

                    const newTargetsDisplay = newTargets.map(n => n.replace(/_/g, ' ')).join('\n  • ');
                    const allTargetsDisplay = warState.targetNations.map(n => n.replace(/_/g, ' ')).join('\n  • ');

                    let response = `🔴 **WAR EXPANDED**\n` +
                        `**${data.nationality.replace(/_/g, ' ')}** (Head of State: ${interaction.user.username})\n` +
                        `declares war on:\n` +
                        `  • ${newTargetsDisplay}\n\n` +
                        `**All enemies:**\n` +
                        `  • ${allTargetsDisplay}\n\n` +
                        `POI capture and full PvP remain enabled!`;

                    if (alreadyAtWar.length > 0) {
                        const alreadyAtWarDisplay = alreadyAtWar.map(n => n.replace(/_/g, ' ')).join(', ');
                        response += `\n\n*Already at war with: ${alreadyAtWarDisplay}*`;
                    }

                    await interaction.reply(response);
                } else {
                    // Start new war
                    warState.active = true;
                    warState.declaredBy = interaction.user.username;
                    warState.declaredAt = new Date().toISOString();
                    warState.declaredByNation = data.nationality;
                    warState.targetNations = targetNations;
                    warState.participants = [data.nationality, ...targetNations];
                    saveData();

                    const targetsDisplay = targetNations.map(n => n.replace(/_/g, ' ')).join('\n  • ');

                    await interaction.reply(
                        `🔴 **WAR DECLARED**\n` +
                        `**${data.nationality.replace(/_/g, ' ')}** (Head of State: ${interaction.user.username})\n` +
                        `declares war on:\n` +
                        `  • ${targetsDisplay}\n\n` +
                        `POI capture and full PvP are now enabled!`
                    );
                }
                break;
            }

            case 'declarepeace': {
                const data = getPlayerDataFromMember(member);

                if (data.rank !== 'Head_of_State') {
                    await interaction.reply('Only Heads of State can declare peace!');
                    return;
                }

                if (!warState.active) {
                    await interaction.reply('There is no active war!');
                    return;
                }

                // Collect all target nations for peace
                const target1 = interaction.options.getString('target1');
                const target2 = interaction.options.getString('target2');
                const target3 = interaction.options.getString('target3');

                let peaceTargets = [target1, target2, target3].filter(t => t !== null);

                // Remove duplicates
                peaceTargets = [...new Set(peaceTargets)];

                // Check if your nation is at war with these targets
                const invalidTargets = peaceTargets.filter(t => !warState.targetNations.includes(t) && warState.declaredByNation !== t);

                if (invalidTargets.length > 0) {
                    await interaction.reply(`❌ You are not at war with: ${invalidTargets.map(n => n.replace(/_/g, ' ')).join(', ')}`);
                    return;
                }

                // Filter out nations you're NOT at war with
                const validPeaceTargets = peaceTargets.filter(t =>
                    warState.targetNations.includes(t) || warState.declaredByNation === t
                );

                if (validPeaceTargets.length === 0) {
                    await interaction.reply('❌ You must specify at least one nation you are currently at war with!');
                    return;
                }

                // Remove peace targets from war
                warState.targetNations = warState.targetNations.filter(t => !validPeaceTargets.includes(t));
                warState.participants = warState.participants.filter(p => !validPeaceTargets.includes(p) || p === warState.declaredByNation);

                const peaceDisplay = validPeaceTargets.map(n => n.replace(/_/g, ' ')).join(', ');

                // If no targets remain, end the war completely
                if (warState.targetNations.length === 0) {
                    warState.active = false;
                    warState.declaredBy = null;
                    warState.declaredAt = null;
                    warState.declaredByNation = null;
                    warState.participants = [];
                    saveData();

                    await interaction.reply(
                        `🟢 **PEACE DECLARED**\n` +
                        `${data.nationality.replace(/_/g, ' ')} has made peace with: ${peaceDisplay}\n\n` +
                        `The war has ended.\n` +
                        `POI capture disabled. Movement still allowed.`
                    );
                } else {
                    saveData();
                    const remainingTargets = warState.targetNations.map(n => n.replace(/_/g, ' ')).join(', ');
                    await interaction.reply(
                        `🟡 **PARTIAL PEACE DECLARED**\n` +
                        `${data.nationality.replace(/_/g, ' ')} has made peace with: ${peaceDisplay}\n\n` +
                        `War continues with: ${remainingTargets}\n` +
                        `POI capture still enabled.`
                    );
                }
                break;
            }

            case 'myinfo': {
                const data = getPlayerDataFromMember(member);
                const steamId = playerData[member.id]?.steamId || 'Not linked';

                await interaction.reply(
                    `**Your Info:**\n` +
                    `Nationality: **${data.nationality.replace(/_/g, ' ')}**\n` +
                    `Rank: **${data.rank.replace(/_/g, ' ')}**\n` +
                    `Steam ID: ${steamId}`
                );
                break;
            }

            case 'playerinfo': {
                const targetUser = interaction.options.getUser('player');
                const targetMember = await interaction.guild.members.fetch(targetUser.id);
                const data = getPlayerDataFromMember(targetMember);
                const steamId = playerData[targetUser.id]?.steamId || 'Not linked';

                await interaction.reply(
                    `**${targetUser.username}'s Info:**\n` +
                    `Nationality: **${data.nationality.replace(/_/g, ' ')}**\n` +
                    `Rank: **${data.rank.replace(/_/g, ' ')}**\n` +
                    `Steam ID: ${steamId}`
                );
                break;
            }

            case 'warstatus': {
                if (warState.active) {
                    const startTime = warState.declaredAt ? new Date(warState.declaredAt).toLocaleString() : 'Unknown';
                    const duration = warState.declaredAt ? Math.floor((Date.now() - new Date(warState.declaredAt)) / 60000) : 0;
                    const targetsDisplay = warState.targetNations.map(n => `**${n.replace(/_/g, ' ')}**`).join(', ');

                    await interaction.reply(
                        `🔴 **WAR IS ACTIVE**\n` +
                        `**${warState.declaredByNation.replace(/_/g, ' ')}** vs ${targetsDisplay}\n\n` +
                        `Declared by: Head of State ${warState.declaredBy}\n` +
                        `Started: ${startTime}\n` +
                        `Duration: ${duration} minutes\n` +
                        `Nations involved: ${warState.participants.length}\n\n` +
                        `**In-Game Effects:**\n` +
                        `✅ POI capture: ENABLED\n` +
                        `✅ PvP: ENABLED`
                    );
                } else {
                    await interaction.reply(
                        `🟢 **PEACE TIME**\n\n` +
                        `**In-Game Effects:**\n` +
                        `❌ POI capture: DISABLED\n` +
                        `✅ Movement: ALLOWED\n\n` +
                        `*A Head of State can declare war using /declarewar*\n` +
                        `*You can declare war on up to 3 nations at once*`
                    );
                }
                break;
            }

            case 'leaderboard': {
                // Group players by nationality and rank
                const nations = { USSR: [], US: [], FIA: [] };
                const rankOrder = { Head_of_State: 0, Politician: 1, General: 2, Captain: 3, Lieutenant: 4, Sergeant: 5, Private: 6 };

                Object.values(playerData).forEach(player => {
                    if (player.nationality && nations[player.nationality]) {
                        nations[player.nationality].push(player);
                    }
                });

                // Sort each nation by rank
                Object.keys(nations).forEach(nat => {
                    nations[nat].sort((a, b) => rankOrder[a.rank] - rankOrder[b.rank]);
                });

                let response = '**📊 PLAYER LEADERBOARD**\n\n';

                for (const [nation, players] of Object.entries(nations)) {
                    if (players.length > 0) {
                        response += `**${nation.replace(/_/g, ' ')}** (${players.length} players)\n`;
                        players.forEach(p => {
                            const steamLinked = p.steamId ? '🔗' : '❌';
                            response += `  ${steamLinked} ${p.rank.replace(/_/g, ' ')} - ${p.username}\n`;
                        });
                        response += '\n';
                    }
                }

                if (Object.values(nations).every(arr => arr.length === 0)) {
                    response += '*No players found. Use /sync to update.*';
                }

                await interaction.reply(response);
                break;
            }

            case 'sync': {
                syncAllPlayers(interaction.guild);
                await interaction.reply('Synced all players!');
                break;
            }

            case 'syncchannels': {
                await interaction.deferReply();
                await syncChannelPermissions(interaction.guild);
                await interaction.editReply('✅ Channel permissions synced! Nationality-restricted channels are now properly configured.');
                break;
            }
        }
    } catch (error) {
        console.error('Command error:', error);
        await interaction.reply('An error occurred!');
    }
});

// HTTP API for game server
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: '*/*' })); // Accept raw text from Arma

// Add CORS headers for game server
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    console.log(`[API] ${req.method} ${req.url}`);
    next();
});

// Get player data by linked identity (steamId field)
// Always fetches fresh nationality/rank from Discord roles
app.get('/api/player/:identifier', async (req, res) => {
    const id = req.params.identifier;
    console.log(`[API] Looking up player by linked identity: ${id}`);

    // Debug: Show all linked steamIds
    const linkedPlayers = Object.values(playerData).filter(p => p.steamId);
    console.log(`[API] Available linked steamIds: ${linkedPlayers.map(p => `${p.steamId} (${p.username})`).join(', ') || 'NONE'}`);

    // Find player entry by steamId
    const playerEntry = Object.entries(playerData).find(([discordId, p]) => p.steamId === id);

    if (!playerEntry) {
        console.log(`[API] Player NOT FOUND: ${id}`);
        console.log(`[API] Hint: Player needs to use /link command with identifier: ${id}`);
        res.status(404).json({ error: 'Player not found', searchedFor: id });
        return;
    }

    const [discordId, storedData] = playerEntry;

    // Fetch FRESH data from Discord roles
    try {
        const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
        if (!guild) {
            console.log(`[API] Guild not found, using stored data`);
            res.json(storedData);
            return;
        }

        const member = await guild.members.fetch(discordId).catch(() => null);
        if (!member) {
            console.log(`[API] Member ${discordId} not in guild, using stored data`);
            res.json(storedData);
            return;
        }

        // Get fresh nationality/rank from Discord roles
        const freshData = getPlayerDataFromMember(member);

        const response = {
            discordId: discordId,
            username: member.user.username,
            nationality: freshData.nationality,
            rank: freshData.rank,
            steamId: storedData.steamId
        };

        console.log(`[API] Found player: ${response.username} (${response.nationality}) - FRESH from Discord roles`);
        res.json(response);
    } catch (err) {
        console.error(`[API] Error fetching Discord data:`, err);
        // Fallback to stored data
        res.json(storedData);
    }
});

// Get all players
app.get('/api/players', (req, res) => {
    res.json(playerData);
});

// Get war state
app.get('/api/war', (req, res) => {
    res.json(warState);
});

// POST territory data from game server
app.post('/api/territory', (req, res) => {
    try {
        // Handle Arma's form-urlencoded JSON (it mangles the JSON into form data)
        let parsedData;

        if (typeof req.body === 'object' && !Array.isArray(req.body)) {
            // Check if this is mangled form data (key starts with "{")
            const firstKey = Object.keys(req.body)[0];
            if (firstKey && firstKey.startsWith('{')) {
                // Reconstruct the JSON string from mangled form data
                // Structure: { '{"bases":': { 'array content': '' } }
                const arrayContent = Object.keys(req.body[firstKey])[0];
                const jsonString = '{"bases":[' + arrayContent + ']}';
                console.log('[API] Reconstructed JSON:', jsonString.substring(0, 150) + '...');
                parsedData = JSON.parse(jsonString);
            } else {
                parsedData = req.body;
            }
        } else if (typeof req.body === 'string') {
            parsedData = JSON.parse(req.body);
        } else {
            parsedData = req.body;
        }

        territoryData = parsedData;
        territoryData.lastUpdate = new Date().toISOString();

        // Save to file
        fs.writeFileSync(CONFIG.TERRITORY_FILE, JSON.stringify(territoryData, null, 2));
        console.log(`[API] Territory data updated: ${territoryData.bases?.length || 0} bases`);

        // Trigger immediate map update
        const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
        if (guild) {
            updateTerritoryMap(guild).catch(err => console.error('Error updating territory map:', err));
        }

        res.json({ success: true, message: 'Territory data received' });
    } catch (error) {
        console.error('[API] Error receiving territory data:', error);
        res.status(500).json({ error: 'Failed to process territory data' });
    }
});

// GET territory data
app.get('/api/territory', (req, res) => {
    res.json(territoryData);
});

app.listen(CONFIG.HTTP_PORT, () => {
    console.log(`HTTP API listening on port ${CONFIG.HTTP_PORT}`);
});

// Login
client.login(CONFIG.TOKEN);
