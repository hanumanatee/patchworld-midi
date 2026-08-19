/**
 * PatchWorld WebBridge API
 * Allows bidirectional communication between a web page and the PatchWorld game engine.
 */

console.log("patchworld-bridge v1.0");

window.PatchWorld = Object.assign(window.PatchWorld || {}, {
    /**
     * Stores the latest context data received from Unity.
     * @type {{
     *   worldId: string,          // The current World's unique ID
     *   isOwner: boolean,         // Whether the local user is the owner of the world
     *   productId: string,        // The Product ID (if applicable)
     *   localPlayer: Object,      // The Local Player object (see below)
     *   masterId: string,         // The playerId of the current Master Client
     *   bridgeId: string,         // The fullID of the PatchworldWebBridge block
     *   browserId: string         // The fullID of the Browser block running this UI
     * }}
     */
    context: null,

    // Stores connected players by playerRef
    players: {},
    LocalPlayer: null,

    // Magic number to tell PatchWorld to ignore an axis when setting transforms
    UNCHANGED: -999999,

    // Lifecycle hooks that developers can override
    onBeforeData: null,
    onData: null,
    onWorldReady: null,
    onDisconnected: null,
    
    // Player events
    onPlayerConnect: null,
    onPlayerDisconnect: null,
    onMasterChanged: null,

    // Scene events
    onBlockSpawned: null,
    onBlockRemoved: null,

    // Interface Block IO events
    onInterfaceMessageIn: null,
    onInterfaceInputPartConnected: null,
    onInterfaceInputPartDisconnected: null,
    onInterfaceInputJoltA: null,
    onInterfaceInputJoltB: null,

    // Enum matching C# BodyPart for targeting player parts
    PlayerBodyPart: {
        Root: 0,
        RightHand: 1,
        RightCTRL: 2,
        LeftHand: 3,
        LeftCTRL: 4,
        Head: 5,
        Feet: 6
    },

    /**
     * Sends a command to PatchWorld and waits for the response.
     * @param {string} command - The command to execute (e.g., "RunCommand").
     * @param {any} args - The arguments for the command (e.g., "SetTimeScale 0.5").
     * @returns {Promise<any>} - A promise that resolves with PatchWorld's response.
     */
    sendToPatchWorld: function(command, args = {}) {
        return new Promise((resolve, reject) => {
            if (!window.vuplex) {
                console.warn("Vuplex is not available. Are you running this inside PatchWorld?");
                // Fallback for local browser testing
                resolve(null);
                return;
            }

            // Generate a unique ID for this request
            const requestId = Math.random().toString(36).substring(2, 11);
            
            // Define the listener that will wait for the specific response
            const listener = function(event) {
                try {
                    const message = JSON.parse(event.data);
                    
                    // Check if this message is the response to our request
                    if (message.replyTo === requestId) {
                        // Stop listening for this specific request
                        window.vuplex.removeEventListener('message', listener);
                        
                        if (message.error) {
                            reject(message.error);
                        } else {
                            resolve(message.data);
                        }
                    }
                } catch (e) {
                    // Ignore non-JSON messages or unrelated errors
                }
            };
            
            // Attach the listener
            window.vuplex.addEventListener('message', listener);
            
            // Send the request
            window.vuplex.postMessage({
                type: command,
                requestId: requestId,
                data: args
            });
        });
    },

    /**
     * Shortcut to execute a console command in PatchWorld.
     * @param {string} commandName - The name of the command (e.g., "SetTimeScale", "ToasterMessage").
     * @param {...any} args - The arguments for the command (can be string, number, etc.).
     * @returns {Promise<any>} - A promise that resolves with the command's result.
     */
    runCommand: function(commandName, ...args) {
        // Format the arguments into a single string for PatchWorld's console parser
        const argsString = args.map(arg => {
            if (arg === "") {
                // Force quotes for empty strings so they aren't lost during space joining
                return `""`;
            }
            if (typeof arg === 'string' && arg.includes(' ')) {
                // Wrap strings with spaces in quotes so PatchWorld parses them as a single argument
                return `"${arg}"`;
            }
            return arg;
        }).join(' ');

        const fullCommandString = `${commandName} ${argsString}`.trim();
        console.log(`[PatchWorld] Sending command: ${fullCommandString}`);
        return this.sendToPatchWorld("RunCommand", fullCommandString);
    },

    /**
     * Extracts the parent device (or group) fullID from a given fullID.
     * fullIDs are structured as paths (e.g. "rootID/groupID/blockID").
     * @param {string} fullID - The fullID of the block.
     * @returns {string} - The fullID of the parent, or an empty string if it's already at the root.
     */
    GetParentDevice: function(fullID) {
        if (!fullID || typeof fullID !== 'string') return "";
        const parts = fullID.split('/');
        if (parts.length <= 1) return "";
        return parts.slice(0, -1).join('/');
    },

    /**
     * Variable System Cache
     * Format: { "VarName": [ { fullId: "...", partId: 0, value: 42.0 } ] }
     */
    variablesCache: {},

    // Variable System Lifecycle hooks
    onVariableAdded: null,
    onVariableChanged: null,
    onVariableRemoved: null,
    onVariableSync: null,

    /**
     * Variable System API
     */
    subscribeVariable: async function(varName) {
        if (!this.variablesCache[varName]) {
            this.variablesCache[varName] = [];
        }
        if (!window.vuplex) return Promise.reject("Vuplex not available");
        window.vuplex.postMessage({ type: "pxr.bridge.var", action: "subscribe", varName: varName });
        return Promise.resolve();
    },

    setVariable: async function(varName, target, value, partID = 0) {
        return this.runCommand("setvariable", varName, target, value, partID);
    },

    removeVariable: async function(varName, target, partID = 0) {
        return this.runCommand("removevariable", varName, target, partID);
    },

    getVariable: function(varName, target, partID = 0) {
        if (!this.variablesCache[varName]) return null;
        const entry = this.variablesCache[varName].find(e => e.fullId === target && e.partId === partID);
        return entry ? entry.value : null;
    },

    getAllWithVariable: function(varName) {
        if (!this.variablesCache[varName]) return [];
        return [...this.variablesCache[varName]];
    },

    /**
     * Interface IO Methods
     * These require the bridge to be active (context.bridgeId must exist).
     */
    interfaceMessageOut: function(txt) {
        if (!window.vuplex) return Promise.reject("Vuplex not available");
        window.vuplex.postMessage({ type: "pxr.bridge.io", action: "messageOut", value: txt });
        return Promise.resolve();
    },
    
    interfaceSendJoltA: function(value) {
        if (!window.vuplex) return Promise.reject("Vuplex not available");
        window.vuplex.postMessage({ type: "pxr.bridge.io", action: "sendJoltA", value: value });
        return Promise.resolve();
    },
    
    interfaceSendJoltB: function(value) {
        if (!window.vuplex) return Promise.reject("Vuplex not available");
        window.vuplex.postMessage({ type: "pxr.bridge.io", action: "sendJoltB", value: value });
        return Promise.resolve();
    },
    
    interfaceClearPartRefs: function() {
        if (!window.vuplex) return Promise.reject("Vuplex not available");
        window.vuplex.postMessage({ type: "pxr.bridge.io", action: "clearPartRefs" });
        return Promise.resolve();
    },
    
    interfaceAddPartRef: function(targetBlock, partID = -1) {
        if (!window.vuplex) return Promise.reject("Vuplex not available");
        window.vuplex.postMessage({ type: "pxr.bridge.io", action: "addPartRef", blockId: targetBlock, partId: partID });
        return Promise.resolve();
    },
    
    interfaceRemovePartRef: function(targetBlock, partID = -1) {
        if (!window.vuplex) return Promise.reject("Vuplex not available");
        window.vuplex.postMessage({ type: "pxr.bridge.io", action: "removePartRef", blockId: targetBlock, partId: partID });
        return Promise.resolve();
    },

    sendWirelessJolt: function(channel, value, channelID = 0, restriction = "") {
        return this.runCommand(`SendWirelessJolt ${value} "${channel}" ${channelID} "${restriction}"`);
    },

    wifiCallbacks: {},
    onWifiJolt: null,

    subscribeWifi: function(channel, callback) {
        if (!window.vuplex) return Promise.reject("Vuplex not available");
        if (callback) {
            if (!this.wifiCallbacks[channel]) this.wifiCallbacks[channel] = [];
            this.wifiCallbacks[channel].push(callback);
        }
        window.vuplex.postMessage({ type: "pxr.bridge.wifi", action: "subscribe", channel: channel });
        return Promise.resolve();
    },

    /**
     * PatchWorld REST API Configuration & Helpers
     */
    API_URL: "https://api.patchxr.io",

    /**
     * Fetches metadata for a specific library asset (block, device, patch).
     * @param {string} assetId - The unique ID of the asset.
     * @returns {Promise<any>}
     */
    fetchAsset: async function(assetId) {
        if (!assetId) throw new Error("Empty asset ID");
        if (window.vuplex) {
            try {
                const res = await this.runCommand("FetchAssetMeta", assetId);
                if (res && res !== "null" && typeof res === 'string' && !res.startsWith("ERROR")) {
                    return JSON.parse(res);
                }
            } catch(e) { console.warn("Bridge FetchAssetMeta fallback:", e); }
        }
        const res = await fetch(`${this.API_URL}/assets/${assetId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    },

    /**
     * Fetches the public profile information of a PatchWorld player (username, bio, avatar).
     * @param {string} userId - The unique ID of the player.
     * @returns {Promise<any>}
     */
    fetchUserProfile: async function(userId) {
        if (!userId) throw new Error("Empty user ID");
        if (window.vuplex) {
            try {
                const res = await this.runCommand("FetchUserProfile", userId);
                if (res && res !== "null" && typeof res === 'string' && !res.startsWith("ERROR")) {
                    return JSON.parse(res);
                }
            } catch(e) { console.warn("Bridge FetchUserProfile fallback:", e); }
        }
        const res = await fetch(`${this.API_URL}/user/${userId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    },

    /**
     * Fetches the public asset library (devices, instruments) published by a specific player.
     * @param {string} userId - The unique ID of the player.
     * @returns {Promise<any>}
     */
    fetchUserAssetLibrary: async function(userId) {
        if (!userId) throw new Error("Empty user ID");
        if (window.vuplex) {
            try {
                const res = await this.runCommand("FetchUserAssetLibrary", userId);
                if (res && res !== "null" && typeof res === 'string' && !res.startsWith("ERROR")) {
                    return JSON.parse(res);
                }
            } catch(e) { console.warn("Bridge FetchUserAssetLibrary fallback:", e); }
        }
        const res = await fetch(`${this.API_URL}/assets/user-library/${userId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    }
});

// Global shorthands for convenience
window.sendToPatchWorld = window.PatchWorld.sendToPatchWorld.bind(window.PatchWorld);
window.runCommand = window.PatchWorld.runCommand.bind(window.PatchWorld);
window.GetParentDevice = window.PatchWorld.GetParentDevice.bind(window.PatchWorld);
window.fetchAsset = window.PatchWorld.fetchAsset.bind(window.PatchWorld);
window.fetchUserProfile = window.PatchWorld.fetchUserProfile.bind(window.PatchWorld);
window.fetchUserAssetLibrary = window.PatchWorld.fetchUserAssetLibrary.bind(window.PatchWorld);

// ==========================================
// Handshake & Lifecycle Management
// ==========================================

function initPatchWorldBridge() {
    if (!window.vuplex) {
        console.warn("Vuplex not found. Waiting for vuplexready event...");
        window.addEventListener('vuplexready', setupBridgeListeners);
    } else {
        setupBridgeListeners();
    }
}

function setupBridgeListeners() {
    // Listen for lifecycle events from Unity
    window.vuplex.addEventListener('message', function(event) {
        try {
            const message = JSON.parse(event.data);
            
            if (message.type === "pxr.bridge.context") {
                window.PatchWorld.players = {};
                window.PatchWorld.LocalPlayer = null;

                if (message.data && message.data.localPlayer) {
                    const lp = message.data.localPlayer;
                    window.PatchWorld.LocalPlayer = lp;
                    window.PatchWorld.players[lp.playerRef] = lp;
                }

                if (typeof window.PatchWorld.onBeforeData === 'function') {
                    window.PatchWorld.onBeforeData();
                }
                
                window.PatchWorld.context = message.data;
                
                if (window.PatchWorld.context.masterId) {
                    window.PatchWorld.masterId = window.PatchWorld.context.masterId;
                }
                
                if (typeof window.PatchWorld.onData === 'function') {
                    window.PatchWorld.onData(window.PatchWorld.context);
                }
            }
            else if (message.type === "pxr.bridge.disconnected") {
                window.PatchWorld.context = null;
                window.PatchWorld.players = {};
                window.PatchWorld.LocalPlayer = null;
                window.PatchWorld.variablesCache = {};
                window.PatchWorld.wifiCallbacks = {};

                if (typeof window.PatchWorld.onDisconnected === 'function') {
                    window.PatchWorld.onDisconnected();
                }
            }
            else if (message.type === "pxr.bridge.worldReady") {
                console.log("[PatchWorld] World is loaded and multiplayer synchronization is complete (OnWorldReady)");
                if (typeof window.PatchWorld.onWorldReady === 'function') {
                    window.PatchWorld.onWorldReady();
                }
            }
            else if (message.type === "pxr.bridge.wifi") {
                const channel = message.channel;
                const value = message.value;
                if (window.PatchWorld.wifiCallbacks[channel]) {
                    window.PatchWorld.wifiCallbacks[channel].forEach(cb => cb(value));
                }
                if (typeof window.PatchWorld.onWifiJolt === 'function') {
                    window.PatchWorld.onWifiJolt(channel, value);
                }
            }
            else if (message.type === "pxr.bridge.var") {
                const action = message.action;
                const varName = message.varName;
                const data = message.data;

                if (!window.PatchWorld.variablesCache[varName]) {
                    window.PatchWorld.variablesCache[varName] = [];
                }

                const cache = window.PatchWorld.variablesCache[varName];

                if (action === "sync") {
                    window.PatchWorld.variablesCache[varName] = data || [];
                    if (typeof window.PatchWorld.onVariableSync === 'function') {
                        window.PatchWorld.onVariableSync(varName, window.PatchWorld.variablesCache[varName]);
                    }
                } 
                else if (action === "added" || action === "changed") {
                    const idx = cache.findIndex(e => e.fullId === data.fullId && e.partId === data.partId);
                    if (idx >= 0) {
                        cache[idx] = data;
                    } else {
                        cache.push(data);
                    }

                    if (action === "added" && typeof window.PatchWorld.onVariableAdded === 'function') {
                        window.PatchWorld.onVariableAdded(varName, data.fullId, data.partId, data.value);
                    } else if (action === "changed" && typeof window.PatchWorld.onVariableChanged === 'function') {
                        window.PatchWorld.onVariableChanged(varName, data.fullId, data.partId, data.value);
                    }
                } 
                else if (action === "removed") {
                    const idx = cache.findIndex(e => e.fullId === data.fullId && e.partId === data.partId);
                    if (idx >= 0) {
                        cache.splice(idx, 1);
                    }
                    if (typeof window.PatchWorld.onVariableRemoved === 'function') {
                        window.PatchWorld.onVariableRemoved(varName, data.fullId, data.partId);
                    }
                }
            }
        } catch (e) {
            // Ignore parse errors
        }
    });

    // Unity will call these internal callbacks via ExecuteJavaScript
    window.PatchWorld._internal_onPlayerConnect = function(player) {
        window.PatchWorld.players[player.playerRef] = player;
        if (player.isLocal) window.PatchWorld.LocalPlayer = player;
        
        if (typeof window.PatchWorld.onPlayerConnect === 'function') {
            window.PatchWorld.onPlayerConnect(player);
        }
    };

    window.PatchWorld._internal_onPlayerDisconnect = function(player) {
        delete window.PatchWorld.players[player.playerRef];
        if (player.isLocal) window.PatchWorld.LocalPlayer = null;
        
        if (typeof window.PatchWorld.onPlayerDisconnect === 'function') {
            window.PatchWorld.onPlayerDisconnect(player);
        }
    };

    window.PatchWorld._internal_onMasterChanged = function(masterId) {
        window.PatchWorld.masterId = masterId;
        if (typeof window.PatchWorld.onMasterChanged === 'function') {
            window.PatchWorld.onMasterChanged(masterId);
        }
    };

    window.PatchWorld._internal_onInterfaceMessageIn = function(txt) {
        if (typeof window.PatchWorld.onInterfaceMessageIn === 'function') {
            window.PatchWorld.onInterfaceMessageIn(txt);
        }
    };

    window.PatchWorld._internal_onBlockSpawned = function(data) {
        if (typeof window.PatchWorld.onBlockSpawned === 'function') {
            window.PatchWorld.onBlockSpawned(data);
        }
    };

    window.PatchWorld._internal_onBlockRemoved = function(data) {
        if (typeof window.PatchWorld.onBlockRemoved === 'function') {
            window.PatchWorld.onBlockRemoved(data);
        }
    };

    window.PatchWorld._internal_onInterfaceInputPartConnected = function(data) {
        if (typeof window.PatchWorld.onInterfaceInputPartConnected === 'function') {
            window.PatchWorld.onInterfaceInputPartConnected(data);
        }
    };

    window.PatchWorld._internal_onInterfaceInputPartDisconnected = function(data) {
        if (typeof window.PatchWorld.onInterfaceInputPartDisconnected === 'function') {
            window.PatchWorld.onInterfaceInputPartDisconnected(data);
        }
    };

    window.PatchWorld._internal_onInterfaceInputJoltA = function(value) {
        if (typeof window.PatchWorld.onInterfaceInputJoltA === 'function') {
            window.PatchWorld.onInterfaceInputJoltA(value);
        }
    };

    window.PatchWorld._internal_onInterfaceInputJoltB = function(value) {
        if (typeof window.PatchWorld.onInterfaceInputJoltB === 'function') {
            window.PatchWorld.onInterfaceInputJoltB(value);
        }
    };

    // Notify Unity that the page is ready to receive context data
    window.vuplex.postMessage({ type: "pxr.bridge.ready" });
}

// Auto-initialize
initPatchWorldBridge();
