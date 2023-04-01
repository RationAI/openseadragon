/*
 * OpenSeadragon - TileCache
 *
 * Copyright (C) 2009 CodePlex Foundation
 * Copyright (C) 2010-2022 OpenSeadragon contributors
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 * - Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * - Redistributions in binary form must reproduce the above copyright
 *   notice, this list of conditions and the following disclaimer in the
 *   documentation and/or other materials provided with the distribution.
 *
 * - Neither the name of CodePlex Foundation nor the names of its
 *   contributors may be used to endorse or promote products derived from
 *   this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
 * TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 * PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 * LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 * NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

(function( $ ){


// private class, but type required for docs
/**
 * @typedef {{
 *    getImage: function,
 *    getData: function,
 *    getRenderedContext: function
 * }} OpenSeadragon.ImageRecord
 */
var ImageRecord = function() {
    this._tiles = [];
};

ImageRecord.prototype = {
    destroy: function() {
        this._tiles = null;
        this.data = null;
    },

    getImage: function (tile) {
        return tile.tiledImage.source.getTileCacheDataAsImage(this);
    },

    getRenderedContext: function (tile) {
        return tile.tiledImage.source.getTileCacheDataAsContext2D(this);
    },

    getData: function (tile) {
        return this.data;
    },

    addTile: function(tile, data) {
        $.console.assert(tile, '[ImageRecord.addTile] tile is required');
        if (this._tiles.includes(tile)) {
            //allow overriding the cache
            this.removeTile(tile);
        } else if (!this.data) {
            this.data = data;
        }

        this._tiles.push(tile);
        tile.tiledImage.source.createTileCache(this, data, tile);
    },

    removeTile: function(tile) {
        for (var i = 0; i < this._tiles.length; i++) {
            if (this._tiles[i] === tile) {
                tile.tiledImage.source.destroyTileCache(this);
                this._tiles.splice(i, 1);
                return;
            }
        }

        $.console.warn('[ImageRecord.removeTile] trying to remove unknown tile', tile);
    },

    getTileCount: function() {
        return this._tiles.length;
    }
};

/**
 * @class TileCache
 * @memberof OpenSeadragon
 * @classdesc Stores all the tiles displayed in a {@link OpenSeadragon.Viewer}.
 * You generally won't have to interact with the TileCache directly.
 * @param {Object} options - Configuration for this TileCache.
 * @param {Number} [options.maxImageCacheCount] - See maxImageCacheCount in
 * {@link OpenSeadragon.Options} for details.
 */
$.TileCache = function( options ) {
    options = options || {};

    this._maxImageCacheCount = options.maxImageCacheCount || $.DEFAULT_SETTINGS.maxImageCacheCount;
    this._tilesLoaded = [];
    this._imagesLoaded = [];
    this._imagesLoadedCount = 0;
};

/** @lends OpenSeadragon.TileCache.prototype */
$.TileCache.prototype = {
    /**
     * @returns {Number} The total number of tiles that have been loaded by
     * this TileCache. Note that the tile is recorded here mutliple times,
     * once for each cache it uses.
     */
    numTilesLoaded: function() {
        return this._tilesLoaded.length;
    },

    /**
     * Caches the specified tile, removing an old tile if necessary to stay under the
     * maxImageCacheCount specified on construction. Note that if multiple tiles reference
     * the same image, there may be more tiles than maxImageCacheCount; the goal is to keep
     * the number of images below that number. Note, as well, that even the number of images
     * may temporarily surpass that number, but should eventually come back down to the max specified.
     * @param {Object} options - Tile info.
     * @param {OpenSeadragon.Tile} options.tile - The tile to cache.
     * @param {String} [options.cacheKey=undefined] - Cache Key to use. Defaults to options.tile.cacheKey
     * @param {String} options.tile.cacheKey - The unique key used to identify this tile in the cache.
     * @param {Image} options.image - The image of the tile to cache.
     * @param {OpenSeadragon.TiledImage} options.tiledImage - The TiledImage that owns that tile.
     * @param {Number} [options.cutoff=0] - If adding this tile goes over the cache max count, this
     *   function will release an old tile. The cutoff option specifies a tile level at or below which
     *   tiles will not be released.
     */
    cacheTile: function( options ) {
        $.console.assert( options, "[TileCache.cacheTile] options is required" );
        $.console.assert( options.tile, "[TileCache.cacheTile] options.tile is required" );
        $.console.assert( options.tile.cacheKey, "[TileCache.cacheTile] options.tile.cacheKey is required" );
        $.console.assert( options.tiledImage, "[TileCache.cacheTile] options.tiledImage is required" );

        var cutoff = options.cutoff || 0,
            insertionIndex = this._tilesLoaded.length,
            cacheKey = options.cacheKey || options.tile.cacheKey;

        var imageRecord = this._imagesLoaded[options.tile.cacheKey];
        if (!imageRecord) {

            if (!options.data) {
                $.console.error("[TileCache.cacheTile] options.image was renamed to options.data. '.image' attribute " +
                    "has been deprecated and will be removed in the future.");
                options.data = options.image;
            }

            $.console.assert( options.data, "[TileCache.cacheTile] options.data is required to create an ImageRecord" );
            imageRecord = this._imagesLoaded[options.tile.cacheKey] = new ImageRecord();
            this._imagesLoadedCount++;
        } else if (imageRecord.__zombie__) {
            delete imageRecord.__zombie__;
            //revive cache, replace from _tilesLoaded so it won't get unloaded
            this._tilesLoaded.splice( imageRecord.__index__, 1 );
            delete imageRecord.__index__;
            insertionIndex--;
        }

        imageRecord.addTile(options.tile, options.data);
        options.tile._cached[ cacheKey ] = imageRecord;

        // Note that just because we're unloading a tile doesn't necessarily mean
        // we're unloading an image. With repeated calls it should sort itself out, though.
        if ( this._imagesLoadedCount > this._maxImageCacheCount ) {
            var worstTile       = null;
            var worstTileIndex  = -1;
            var prevTile, worstTime, worstLevel, prevTime, prevLevel;

            for ( var i = this._tilesLoaded.length - 1; i >= 0; i-- ) {
                prevTile = this._tilesLoaded[ i ];

                //todo try different approach? the only ugly part, keep tilesLoaded array empty of unloaded tiles
                if (!prevTile.loaded) {
                    //iterates from the array end, safe to remove
                    this._tilesLoaded.splice( i, 1 );
                    continue;
                }

                if ( prevTile.__zombie__ !== undefined ) {
                    //remove without hesitation, ImageObject record
                    worstTile       = prevTile.__zombie__;
                    worstTileIndex  = i;
                    break;
                }

                if ( prevTile.level <= cutoff || prevTile.beingDrawn ) {
                    continue;
                } else if ( !worstTile ) {
                    worstTile       = prevTile;
                    worstTileIndex  = i;
                    continue;
                }

                prevTime    = prevTile.lastTouchTime;
                worstTime   = worstTile.lastTouchTime;
                prevLevel   = prevTile.level;
                worstLevel  = worstTile.level;

                if ( prevTime < worstTime ||
                    ( prevTime === worstTime && prevLevel > worstLevel )) {
                    worstTile       = prevTile;
                    worstTileIndex  = i;
                }
            }

            if ( worstTile && worstTileIndex >= 0 ) {
                this._unloadTile(worstTile, true);
                insertionIndex = worstTileIndex;
            }
        }

        this._tilesLoaded[ insertionIndex ] = options.tile;
    },

    /**
     * Clears all tiles associated with the specified tiledImage.
     * @param {OpenSeadragon.TiledImage} tiledImage
     */
    clearTilesFor: function( tiledImage ) {
        $.console.assert(tiledImage, '[TileCache.clearTilesFor] tiledImage is required');
        var tile;
        for ( var i = this._tilesLoaded.length - 1; i >= 0; i-- ) {
            tile = this._tilesLoaded[ i ];

            //todo try different approach? the only ugly part, keep tilesLoaded array empty of unloaded tiles
            if (!tile.loaded) {
                //iterates from the array end, safe to remove
                this._tilesLoaded.splice( i, 1 );
            } else if ( tile.tiledImage === tiledImage ) {
                this._unloadTile(tile, !tiledImage._zombieCache ||
                    this._imagesLoadedCount > this._maxImageCacheCount, i);
            }
        }
    },

    // private
    getImageRecord: function(cacheKey) {
        $.console.assert(cacheKey, '[TileCache.getImageRecord] cacheKey is required');
        return this._imagesLoaded[cacheKey];
    },

    /**
     * @param tile tile to unload
     * @param destroy destroy tile cache if the cache tile counts falls to zero
     * @param deleteAtIndex index to remove the tile record at, will not remove from _tiledLoaded if not set
     * @private
     */
    _unloadTile: function(tile, destroy, deleteAtIndex) {
        $.console.assert(tile, '[TileCache._unloadTile] tile is required');
        var tiledImage = tile.tiledImage;

        for (var key in tile._cached) {
            var imageRecord = this._imagesLoaded[key];
            if (imageRecord) {
                imageRecord.removeTile(tile);
                if (!imageRecord.getTileCount()) {
                    if (destroy) {
                        // #1 tile marked as destroyed (e.g. too much cached tiles or not a zombie)
                        imageRecord.destroy();
                        delete this._imagesLoaded[tile.cacheKey];
                        this._imagesLoadedCount--;

                        //delete also the tile record
                        if (deleteAtIndex !== undefined) {
                            this._tilesLoaded.splice( deleteAtIndex, 1 );
                        }
                    } else if (deleteAtIndex !== undefined) {
                        // #2 Tile is a zombie. Do not delete record, reuse.
                        // a bit dirty but performant... -> we can remove later, or revive
                        // we can do this, in array the tile is once for each its cache object
                        this._tilesLoaded[ deleteAtIndex ] = imageRecord;
                        imageRecord.__zombie__ = tile;
                        imageRecord.__index__ = deleteAtIndex;
                    }
                } else if (deleteAtIndex !== undefined) {
                    // #3 Cache stays. Tile record needs to be removed anyway, since the tile is removed.
                    this._tilesLoaded.splice( deleteAtIndex, 1 );
                }
            } else {
                $.console.warn("[TileCache._unloadTile] Attempting to delete missing cache!");
            }
        }
        tile.unload();

        /**
         * Triggered when a tile has just been unloaded from memory.
         *
         * @event tile-unloaded
         * @memberof OpenSeadragon.Viewer
         * @type {object}
         * @property {OpenSeadragon.TiledImage} tiledImage - The tiled image of the unloaded tile.
         * @property {OpenSeadragon.Tile} tile - The tile which has been unloaded.
         */
        tiledImage.viewer.raiseEvent("tile-unloaded", {
            tile: tile,
            tiledImage: tiledImage
        });
    }
};

}( OpenSeadragon ));
