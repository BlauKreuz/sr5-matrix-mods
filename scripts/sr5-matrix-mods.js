const MODULE_ID = 'sr5-matrix-mods';
const SR5_TEMPLATE = 'systems/shadowrun5e/dist/templates';

Hooks.once('init', () => {
    game.settings.register(MODULE_ID, 'hideMatrixOfflineRows', {
        name: 'Hide Offline Matrix Icons From Players',
        hint: 'When enabled, offline Matrix rows are hidden from non-GM users.',
        scope: 'world',
        config: true,
        type: Boolean,
        default: true,
        onChange: () => _applyMatrixOfflineVisibility(),
    });
});

Hooks.once('setup', _patchHostVariantActorNetwork);

Hooks.on('getActorContextOptions', (_directory, options) => {
    options.push({
        label: 'SR5 Matrix Mods: Toggle Host Variant',
        icon: 'fa-solid fa-server',
        visible: li => {
            const actor = _getActorFromDirectoryEntry(li);
            return game.user.isGM && actor?.type === 'ic';
        },
        onClick: async (_event, li) => {
            const actor = _getActorFromDirectoryEntry(li);
            if (!actor) return;
            if (_isHostVariant(actor)) {
                await actor.unsetFlag(MODULE_ID, 'hostVariant');
                return;
            }
            await actor.setFlag(MODULE_ID, 'hostVariant', true);
            await actor.update({
                system: {
                    host: {
                        rating: 3,
                        atts: {
                            att1: { value: 6, att: 'attack' },
                            att2: { value: 5, att: 'sleaze' },
                            att3: { value: 4, att: 'data_processing' },
                            att4: { value: 3, att: 'firewall' },
                        },
                    },
                },
            });
        },
    });
});

async function registerTemplateOverride(systemPath, moduleFile) {
    const response = await fetch(`modules/${MODULE_ID}/templates/${moduleFile}`);
    if (!response.ok) {
        console.error(`SR5 Matrix Mods | Failed to load template override: ${moduleFile} (${response.status})`);
        return;
    }
    Handlebars.registerPartial(systemPath, Handlebars.compile(await response.text()));
}

Hooks.once('ready', async () => {
    if (game.user.isGM) {
        const worldSettings = game.settings.storage.get('world');
        const oldSetting = worldSettings?.getSetting('sr5-custom-ui.hideMatrixOfflineRows');
        const newSetting = worldSettings?.getSetting(`${MODULE_ID}.hideMatrixOfflineRows`);
        if (oldSetting && !newSetting) {
            await game.settings.set(MODULE_ID, 'hideMatrixOfflineRows', oldSetting.value);
        }
    }

    await registerTemplateOverride(
        `${SR5_TEMPLATE}/v2/list-items/network_icon/item.hbs`,
        'list-items/network_icon/item.hbs',
    );
    _patchConnectedIconsHelper();
});

function _isHostVariant(actor) {
    return actor?.type === 'ic' && actor.getFlag(MODULE_ID, 'hostVariant') === true;
}

function _hostOnlineMatrixItems(actor) {
    if (!_isHostVariant(actor)) return [];
    return actor.items.filter(item => item.isMatrixDevice && item.system.technology?.wireless === 'online');
}

function _patchConnectedIconsHelper() {
    const original = Handlebars.helpers.hasConnectedIcons;
    if (!original || original._sr5MatrixModsPatched) return;
    const patched = function(target, ...args) {
        if (_isHostVariant(target?.document)) {
            return target.markId != null && _hostOnlineMatrixItems(target.document).length > 0;
        }
        return original.call(this, target, ...args);
    };
    patched._sr5MatrixModsPatched = true;
    Handlebars.registerHelper('hasConnectedIcons', patched);
}

function _patchHostConnectedItems(app) {
    if (app._sr5MatrixModsConnectedItemsPatched) return;

    if (typeof app._prepareSelectedMatrixTargets === 'function') {
        const prepareNetworkTargets = app._prepareSelectedMatrixTargets;
        app._prepareSelectedMatrixTargets = function(targets) {
            prepareNetworkTargets.call(this, targets);
            for (const target of targets) {
                if (_isHostVariant(target.document)) target.icons = [];
            }
        };
    }

    if (typeof app._prepareMarkedDocumentTargets === 'function') {
        const prepareMarkedTargets = app._prepareMarkedDocumentTargets;
        app._prepareMarkedDocumentTargets = function(markedDocuments) {
            const targets = prepareMarkedTargets.call(this, markedDocuments);
            for (const target of targets) {
                if (!_isHostVariant(target.document) || !this._connectedIconsOpenClose[target.document.uuid]) continue;
                target.icons = _hostOnlineMatrixItems(target.document).map(item => ({
                name: item.name,
                document: item,
                token: null,
                runningSilent: item.isRunningSilent(),
                network: item.master?.name ?? '',
                type: CONFIG.SR5.itemTypes[item.type],
                icons: [],
                marks: 0,
                markId: null,
                selected: this.selectedMatrixTarget === item.uuid,
                }));
            }
            return targets;
        }
    }

    app._sr5MatrixModsConnectedItemsPatched = true;
}

function _patchHostActorItemDrop(app) {
    if (app._sr5MatrixModsItemDropPatched || typeof app._onDropItem !== 'function') return;
    const onDropItem = app._onDropItem;
    app._onDropItem = async function(event, item, ...args) {
        if (!_isHostVariant(this.actor) || !['equipment', 'device'].includes(item?.type) || !item.isMatrixDevice) {
            return onDropItem.call(this, event, item, ...args);
        }

        const source = foundry.utils.deepClone(item.toObject());
        delete source._id;
        delete source.folder;
        delete source.sort;
        const [created] = await this.actor.createEmbeddedDocuments('Item', [source]);
        return created;
    };
    app._sr5MatrixModsItemDropPatched = true;
}

function _getActorFromDirectoryEntry(entry) {
    const element = entry?.jquery ? entry[0] : entry;
    const id = element?.closest?.('[data-entry-id]')?.dataset?.entryId
        ?? element?.dataset?.entryId
        ?? element?.dataset?.documentId
        ?? element?.dataset?.entityId
        ?? entry?.data?.('documentId')
        ?? entry?.data?.('entityId');
    return id ? game.actors.get(id) : null;
}

function _patchHostVariantActorNetwork() {
    const prototype = CONFIG.Actor?.documentClass?.prototype;
    if (!prototype || prototype._sr5MatrixModsHostNetworkPatched) return;
    const isType = prototype.isType;
    const connectNetwork = prototype.connectNetwork;

    prototype.isType = function(...types) {
        if (this._sr5MatrixModsConnectingHostToGrid && types.length === 1 && types[0] === 'ic') return false;
        return isType.call(this, ...types);
    };

    prototype.connectNetwork = async function(network, ...args) {
        if (!_isHostVariant(this) || !network?.isType?.('grid')) {
            return connectNetwork.call(this, network, ...args);
        }
        this._sr5MatrixModsConnectingHostToGrid = true;
        try {
            return await connectNetwork.call(this, network, ...args);
        } finally {
            delete this._sr5MatrixModsConnectingHostToGrid;
        }
    };

    Object.defineProperty(prototype, '_sr5MatrixModsHostNetworkPatched', { value: true });
}

function _actorIsConnectedToNetwork(sheetRoot) {
    const statusLabel = sheetRoot.querySelector('.split-container .list-item-header .list-item-start label');
    const text = statusLabel?.textContent?.trim() ?? '';
    if (text.includes('No Network')) return false;
    if (text) return true;
    return !sheetRoot.querySelector('.split-container .list-item-header')?.textContent?.includes('No Network');
}

function _matrixDeviceCandidates(actor) {
    if (!actor?.items) return [];
    return actor.items.filter(item => item.type === 'device' && item.canBeWireless?.());
}

function _resolveNetworkRowDocument(row) {
    const uuid = row.querySelector(':scope > .list-item[data-uuid]')?.dataset.uuid;
    if (!uuid) return null;
    try { return fromUuidSync(uuid); } catch (error) { return null; }
}

function _labelConnectedNetworkItems(scope) {
    scope.querySelectorAll('#network-icons-scroll .list-item-subcategory').forEach(row => {
        const item = _resolveNetworkRowDocument(row);
        if (item?.documentName !== 'Item') return;
        const typeKey = CONFIG.SR5?.itemTypes?.[item.type];
        if (!typeKey) return;
        const typeLabel = row.querySelector('.matrix-icon-col label');
        if (typeLabel) typeLabel.textContent = game.i18n.localize(typeKey);
    });
}

function _isRunningSilentMatrixTarget(document) {
    return document?.isRunningSilent?.() === true;
}

function _withSilentActorVisible(matrixActor, target) {
    const ownMethod = Object.getOwnPropertyDescriptor(target, 'isRunningSilent');
    try {
        Object.defineProperty(target, 'isRunningSilent', {
            configurable: true,
            value: () => false,
        });
        return matrixActor.matrixPersonaIsVisible(target);
    } catch (error) {
        return false;
    } finally {
        if (ownMethod) Object.defineProperty(target, 'isRunningSilent', ownMethod);
        else delete target.isRunningSilent;
    }
}

function _collectSilentMatrixTargets(matrixActor, existingTargets) {
    if (!matrixActor?.hasPersona) return [];
    const existing = new Set(existingTargets.map(target => target.document.uuid));
    const targets = [];
    const add = (document, token, networkName) => {
        if (!document?.uuid || document.uuid === matrixActor.uuid || existing.has(document.uuid)) return;
        if (!_isRunningSilentMatrixTarget(document)) return;
        if (document.documentName === 'Actor' && ((document.type === 'ic' && !_isHostVariant(document)) || (!document.hasPersona && !document.hasWirelessDevices()))) return;
        if (document.documentName === 'Item' && !document.isMatrixDevice) return;
        existing.add(document.uuid);
        targets.push({
            name: token?.name ?? document.name,
            document,
            token: token ?? null,
            runningSilent: true,
            network: networkName ?? document.network?.name ?? document.master?.name ?? '',
            icons: [],
        });
    };

    const network = matrixActor.network;
    if (network?.isType?.('host')) {
        for (const slave of network.slaves ?? []) add(slave, slave.getToken?.(), network.name);
    } else {
        for (const grid of game.items.filter(item => item.isType?.('grid') && item.matrixIconVisibleToPlayer?.())) {
            for (const slave of grid.slaves ?? []) {
                if (slave.documentName === 'Actor' && slave.getToken?.()) continue;
                add(slave, null, grid.name);
            }
        }

        for (const token of canvas.tokens.placeables ?? []) {
            const target = token.actor;
            if (!target?.uuid || target.uuid === matrixActor.uuid || target.type === 'ic') continue;
            if (!target.hasPersona && !target.hasWirelessDevices()) continue;
            if (!_isRunningSilentMatrixTarget(target) || !_withSilentActorVisible(matrixActor, target)) continue;
            add(target, token, target.network?.name ?? '');
        }
    }

    return targets;
}

function _collectHostVariantTargets(matrixActor, existingTargets) {
    if (!matrixActor?.hasPersona) return [];
    const existing = new Set(existingTargets.map(target => target.document.uuid));
    const targets = [];
    const matrixActorGrid = _getMatrixGrid(matrixActor);
    for (const actor of game.actors.filter(_isHostVariant)) {
        if (actor.uuid === matrixActor.uuid) continue;
        const grid = _getMatrixGrid(actor);
        const target = existingTargets.find(entry => entry.document.uuid === actor.uuid);
        const matrixModsDifferentGrid = !matrixActorGrid || !grid || matrixActorGrid.uuid !== grid.uuid;
        if (target) {
            target.matrixModsDifferentGrid = matrixModsDifferentGrid;
            continue;
        }
        targets.push({
            name: actor.getToken?.()?.name ?? actor.name,
            document: actor,
            token: actor.getToken?.() ?? null,
            runningSilent: _isRunningSilentMatrixTarget(actor),
            network: grid?.name ?? '',
            matrixModsDifferentGrid,
            icons: [],
        });
    }
    return targets;
}

function _getMatrixGrid(actor) {
    if (actor?.documentName === 'Item' && actor.isType?.('grid')) return actor;
    if (actor?.documentName === 'Item' && !actor.isMatrixDevice && !actor.isNetwork?.()) return null;
    const network = actor?.documentName === 'Item' ? actor.master : actor?.network;
    if (network?.isType?.('grid')) return network;
    if (network?.isType?.('host') && network.master?.isType?.('grid')) return network.master;
    return null;
}

function _patchSilentMatrixTargets(app) {
    if (app._sr5MatrixModsPatched || typeof app._prepareMatrixTargets !== 'function') return;
    const prepareTargets = app._prepareMatrixTargets;
    app._prepareMatrixTargets = function(data) {
        prepareTargets.call(this, data);
        let targets = data.matrixTargets ?? [];
        const hostTargets = _collectHostVariantTargets(this.actor, targets);
        if (hostTargets.length) {
            this._prepareSelectedMatrixTargets(hostTargets);
            targets.push(...hostTargets);
        }
        if (game.user.isGM) {
            const silentTargets = _collectSilentMatrixTargets(this.actor, targets);
            if (silentTargets.length) {
                this._prepareSelectedMatrixTargets(silentTargets);
                targets.push(...silentTargets);
            }
        } else {
            const actorGrid = _getMatrixGrid(this.actor);
            targets = targets.filter(target => {
                if (_isHostVariant(target.document)) return true;
                if (_isRunningSilentMatrixTarget(target.document)) return false;
                const targetGrid = _getMatrixGrid(target.document);
                return !!actorGrid && !!targetGrid && actorGrid.uuid === targetGrid.uuid;
            });
            data.matrixTargets = targets;
        }
    };
    app._sr5MatrixModsPatched = true;
    queueMicrotask(() => {
        if (app.rendered) void app.render();
    });
}

function _refineNetworkPersonaRows(root, matrixActor) {
    const scopes = root ? [root] : document.querySelectorAll('.sr5v2');
    const actorGrid = _getMatrixGrid(matrixActor);
    for (const scope of scopes) {
        _labelConnectedNetworkItems(scope);
        scope.querySelectorAll('#marked-icons-scroll .list-item-container').forEach(row => {
            const document = _resolveNetworkRowDocument(row);
            if (!_isHostVariant(document)) return;
            const typeLabel = row.querySelector('.matrix-icon-col label');
            if (typeLabel) typeLabel.textContent = 'Host';
        });
        const rows = scope.querySelectorAll('#network-icons-scroll > .list-item-container:not(.list-item-subcategory)');
        const personaActorUuids = new Set();
        rows.forEach(row => {
            const doc = _resolveNetworkRowDocument(row);
            if (doc?.documentName === 'Actor') personaActorUuids.add(doc.uuid);
        });

        rows.forEach(row => {
            row.classList.remove('sr5cui-persona-mode', 'sr5cui-device-mode', 'sr5cui-fully-offline', 'sr5cui-duplicate-device', 'sr5cui-off-grid');
            const doc = _resolveNetworkRowDocument(row);
            if (!doc) return;

            if (doc.documentName === 'Item' && doc.parent?.documentName === 'Actor' && personaActorUuids.has(doc.parent.uuid)) {
                row.classList.add('sr5cui-duplicate-device');
                return;
            }

            const actor = doc.documentName === 'Actor' ? doc : (doc.documentName === 'Item' && doc.parent?.documentName === 'Actor' ? doc.parent : null);
            if (!actor) return;
            if (_isHostVariant(actor)) {
                row.classList.add('sr5cui-persona-mode');
                const hostGrid = _getMatrixGrid(actor);
                if (!actorGrid || !hostGrid || actorGrid.uuid !== hostGrid.uuid) row.classList.add('sr5cui-off-grid');
                const hostLabel = row.querySelector('.matrix-icon-col label');
                if (hostLabel) hostLabel.textContent = 'Host';
                return;
            }
            const deviceCandidates = _matrixDeviceCandidates(actor);
            const equippedOnline = deviceCandidates.filter(item => item.isEquipped() && item.system.technology?.wireless === 'online');
            const anyOnline = deviceCandidates.filter(item => item.system.technology?.wireless === 'online');

            if (equippedOnline.length) {
                row.classList.add('sr5cui-persona-mode');
            } else if (anyOnline.length) {
                row.classList.add('sr5cui-device-mode');
                const typeLabel = row.querySelector('.matrix-icon-col label');
                if (typeLabel) typeLabel.textContent = game.i18n.localize('SR5.ItemTypes.Device');
                const nameLink = row.querySelector('.list-item-start a[data-action="openUuid"]');
                if (nameLink) nameLink.textContent = anyOnline[0].name;
                const image = row.querySelector('.list-item-image-target');
                if (image) image.src = anyOnline[0].img;
            } else {
                row.classList.add('sr5cui-fully-offline');
            }
        });
    }
}

function _applyMatrixOfflineVisibility(root, matrixActor) {
    const hidePlayerOnly = !game.user.isGM;
    const scopes = root ? [root] : document.querySelectorAll('.sr5v2');
    if (!canvas.scene) return;
    const allCanvasTokens = canvas.tokens.placeables;
    const actorGrid = _getMatrixGrid(matrixActor);

    for (const scope of scopes) {
        const playersWouldSeeNetwork = _actorIsConnectedToNetwork(scope);
        const hideAll = hidePlayerOnly && !playersWouldSeeNetwork;
        const applyRowVisibility = (row, inherited = null) => {
            row.classList.remove('sr5cui-hidden', 'sr5cui-hidden-from-players');
            const isSilent = _isRunningSilentMatrixTarget(_resolveNetworkRowDocument(row));
            row.classList.toggle('sr5cui-running-silent', isSilent);

            if (inherited) {
                if (inherited.hidden || row.classList.contains('sr5cui-duplicate-device')) {
                    row.classList.add('sr5cui-hidden');
                    return { hidden: true, dimmed: false, offGrid: inherited.offGrid };
                }
                if (inherited.dimmed) row.classList.add('sr5cui-hidden-from-players');
                if (inherited.offGrid) row.classList.add('sr5cui-off-grid');
                return inherited;
            }

            const rowDocument = _resolveNetworkRowDocument(row);
            const rowGrid = _getMatrixGrid(rowDocument);
            const offGrid = !!matrixActor && (!actorGrid || !rowGrid || actorGrid.uuid !== rowGrid.uuid);
            row.classList.toggle('sr5cui-off-grid', offGrid);

            const rowUuid = row.querySelector('[data-uuid]')?.getAttribute('data-uuid');
            const matchedToken = rowUuid && allCanvasTokens.find(token => (token.actor?.uuid || token.actor?._uuid) === rowUuid);
            if (matchedToken?.document?.hidden === true || matchedToken?.actor?.token?.hidden === true) {
                row.classList.add('sr5cui-hidden');
                return { hidden: true, dimmed: false, offGrid };
            }

            const isOffline = row.closest('#network-icons-scroll') && row.classList.contains('sr5cui-fully-offline');
            const hideOfflineSetting = game.settings.get(MODULE_ID, 'hideMatrixOfflineRows');
            const hiddenFromPlayers = !game.user.isGM && (hideAll || isSilent || (hideOfflineSetting && isOffline));
            const dimmed = game.user.isGM && (!playersWouldSeeNetwork || isSilent || (hideOfflineSetting && isOffline));
            if (dimmed) row.classList.add('sr5cui-hidden-from-players');
            else if (hiddenFromPlayers) row.classList.add('sr5cui-hidden');
            return { hidden: hiddenFromPlayers || row.classList.contains('sr5cui-duplicate-device'), dimmed, offGrid };
        };

        for (const selector of ['#network-icons-scroll', '#marked-icons-scroll']) {
            const list = scope.querySelector(selector);
            if (!list) continue;
            let parentVisibility = null;
            for (const row of list.querySelectorAll(':scope > .list-item-container')) {
                if (row.classList.contains('list-item-subcategory')) {
                    applyRowVisibility(row, parentVisibility ?? { hidden: false, dimmed: false });
                } else {
                    parentVisibility = applyRowVisibility(row);
                }
            }
        }
    }
}

Hooks.on('renderApplicationV2', (app, element) => {
    _patchHostActorItemDrop(app);
    _patchHostConnectedItems(app);
    _patchSilentMatrixTargets(app);
    _refineNetworkPersonaRows(element, app.actor);
    _applyMatrixOfflineVisibility(element, app.actor);
});
