(function( $ ){
    const OpenSeadragon = $;

   /**
    * @property {Number} numOfDrawers number of instances of WebGLDrawerModular
    *
    * @class OpenSeadragon.WebGLDrawerModular
    * @classdesc implementation of WebGL renderer for an {@link OpenSeadragon.Viewer}
    */
    OpenSeadragon.WebGLDrawerModular = class extends OpenSeadragon.DrawerBase {
        /**
         * @param {Object} options options for this Drawer
         * @param {OpenSeadragon.Viewer} options.viewer the Viewer that owns this Drawer
         * @param {OpenSeadragon.Viewport} options.viewport reference to Viewer viewport
         * @param {HTMLElement} options.element parent element
         * @param {[String]} options.debugGridColor see debugGridColor in {@link OpenSeadragon.Options} for details
         * @param {Object} options.options optional
         *
         * @constructor
         * @memberof OpenSeadragon.WebGLDrawerModular
         */
        constructor(options){
            super(options);
            this._id = this.constructor.numOfDrawers++;

            this._destroyed = false;
            this._tileIdCounter = 0;

            this._outputCanvas = null;
            this._outputContext = null;
            this._clippingCanvas = null;
            this._clippingContext = null;
            this._renderingCanvas = null;
            this._gl = null;
            this._renderingCanvasHasImageData = false;

            this._backupCanvasDrawer = null;
            this._imageSmoothingEnabled = false; // will be updated by setImageSmoothingEnabled

            this._sessionInfo = {}; // attribute containing session info, used for exporting
            this._supportedFormats = ["context2d", "image"];


            // SETUP WEBGLMODULE
            const rendererOptions = $.extend({
                // Allow override:
                ready: () => {},
                resetCallback: () => { this.viewer.world.draw(); },
                refetchCallback: () => { this.viewer.world.resetItems(); },
                debug: false,
                webGLPreferredVersion: "2.0",
            },
                this.options,
            {
                // Do not allow override:
                uniqueId: "osd_" + this._id,
                canvasOptions: {
                    stencil: true
                }
            });
            this.renderer = new $.WebGLModule(rendererOptions);
            this._layerCount = this.viewer.world.getItemCount(); // todo each tiled image can carry N objects, we need to split these

            this.renderer.setDataBlendingEnabled(true); // enable alpha blending
            this.webGLVersion = this.renderer.webglVersion;
            this.debug = rendererOptions.debug;

            // SETUP CANVASES
            this._size = new $.Point(this.canvas.width, this.canvas.height); // current viewport size, changed during resize event
            this._setupCanvases();
            this.context = this._outputContext; // API required by tests

            // Create a link for downloading off-screen textures, or input image data tiles. Only for the main drawer, not the minimap.
            // Generated with ChatGPT, customized.
            if (this._id === 0 && this.debug) {
                const canvas = document.createElement("canvas");
                canvas.id = 'download-off-screen-textures';
                canvas.href = '#';  // make it a clickable link
                canvas.textContent = 'Download off-screen textures';

                const element = document.getElementById('panel-shaders');
                if (!element) {
                    console.warn('Element with id "panel-shaders" not found, appending download link for off-screen textures to body.');
                    document.body.appendChild(canvas);
                } else {
                    element.appendChild(canvas);
                }
                this._debugCanvas = canvas; //todo dirty
                this._debugCanvas.style.position = 'absolute';
                this._debugCanvas.style.top = '0px';
                this._debugCanvas.style.width = '250px';
                this._debugCanvas.style.height = '250px';
                this._extractionFB =  this.renderer.gl.createFramebuffer();

                this._debugIntermediate = document.createElement("canvas");

            }

            // reject listening for the tile-drawing and tile-drawn events, which this drawer does not fire
            this.viewer.rejectEventHandler("tile-drawn", "The WebGLDrawer does not raise the tile-drawn event");
            this.viewer.rejectEventHandler("tile-drawing", "The WebGLDrawer does not raise the tile-drawing event");


            this.viewer.world.addHandler("remove-item", (e) => {
                // delete export info about this tiledImage
                delete this._sessionInfo[e.item.source.__renderInfo.externalId];

                // Todo some better design, call to this.renderer.setShaderLayerOrder() does not trigger rebuild..
                this.renderer.setShaderLayerOrder(this.viewer.world._items.filter(ti => ti !== e.item).map(item =>
                    Object.values(item.source.__renderInfo.drawers[this._id].shaders).map(shaderConf => shaderConf.id)
                ).flat());

                for (const sourceID of Object.keys(e.item.source.__renderInfo.drawers[this._id].shaders)) {
                    const sourceJSON = e.item.source.__renderInfo.drawers[this._id].shaders[sourceID];
                    // todo this calls createProgam in a loop!
                    this.renderer.removeShader(sourceJSON);
                }
                //todo internals touching
                this._requestRebuild();
                this.renderer.setDimensions(0, 0, this.canvas.width, this.canvas.height, this.viewer.world.getItemCount());

                // these lines are unnecessary because somehow when the same tiledImage is added again it does not have .source.__renderInfo.drawers parameter (I do not know why tho)
                delete e.item.source.__renderInfo.drawers[this._id];
                // no more WebGLDrawerModular instances are using this tiledImage
                if (Object.keys(e.item.source.__renderInfo.drawers).length === 0) {
                    delete e.item.source.__renderInfo.id;
                    delete e.item.source.__renderInfo.externalId;
                    delete e.item.source.__renderInfo.sources;
                    delete e.item.source.__renderInfo.shaders;
                    delete e.item.source.__renderInfo.drawers;
                    delete e.item.source.__renderInfo;
                }

                //todo remove 'composite-operation-change' event
            });
        } // end of constructor

        /**
         * Drawer type.
         * @returns {String}
         */
        getType() {
            return 'modular-webgl-work';
        }

        getSupportedDataFormats() {
            return this._supportedFormats;
        }

        getRequiredDataFormats() {
            return this._supportedFormats;
        }

        get defaultOptions() {
            return {
                usePrivateCache: true,
                preloadCache: false,
            };
        }

        /**
         * Clean up the WebGLDrawerModular, removing all resources.
         */
        destroy() {
            if (this._destroyed) {
                return;
            }
            const gl = this._gl;


            // clean all texture units; adapted from https://stackoverflow.com/a/23606581/1214731
            var numTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
            for (let unit = 0; unit < numTextureUnits; ++unit) {
                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, null);
                gl.bindTexture(gl.TEXTURE_CUBE_MAP, null); //unused

                if (this.webGLVersion === "2.0") {
                    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
                    gl.bindTexture(gl.TEXTURE_3D, null); //unused
                }
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null); //unused
            gl.bindRenderbuffer(gl.RENDERBUFFER, null); //unused
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

            // make canvases 1 x 1 px and delete references
            this._clippingCanvas.width = this._clippingCanvas.height = 1;
            this._outputCanvas.width = this._outputCanvas.height = 1;
            this._renderingCanvas.width = this._renderingCanvas.height = 1;
            this._clippingCanvas = this._clippingContext = null;
            this._outputCanvas = this._outputContext = null;

            this._renderingCanvas = null;
            let ext = gl.getExtension('WEBGL_lose_context');
            if (ext) {
                ext.loseContext();
            }
            // set our webgl context reference to null to enable garbage collection
            this._gl = null;

            gl.deleteFramebuffer(this._extractionFB);
            // unbind our event listeners from the viewer
            this.viewer.removeHandler("resize", this._resizeHandler);

            if (this._backupCanvasDrawer){
                this._backupCanvasDrawer.destroy();
                this._backupCanvasDrawer = null;
            }

            this.container.removeChild(this.canvas);
            if (this.viewer.drawer === this){
                this.viewer.drawer = null;
            }

            // set our destroyed flag to true
            this._destroyed = true;
        }

        /**
         * Configure TiledImage's properties when entering the system.
         * @param {TiledImage} item
         * @param {Number} externalId
         *
         * @typedef {Object} shaderConfig
         * @param {Object} shaders map; {shaderID: shaderConfig}
         * @param {String} shaderConfig.name
         * @param {String} shaderConfig.type
         *
         * @param {Number} shaderConfig.visible
         * @param {Boolean} shaderConfig.fixed
         * @param {[Number]} shaderConfig.dataReferences // for backward compatibility
         * @param {Object} shaderConfig.params
         * @param {Object} shaderConfig.cache
         * @param {Boolean} shaderConfig._cacheApplied   // use cache object
         *
         * @returns {Object} TiledImageInfo
         * @returns {Number} TiledImageInfo.id
         * @returns {[Number]} TiledImageInfo.sources
         * @returns {Object} TiledImageInfo.shaders
         * @returns {Object} TiledImageInfo.drawers
         * @returns {Number} TiledImageInfo.externalId
         */
        configureTiledImage(item, shaders = undefined, orderOfDataSources = [0], externalId = Date.now()) {
            let tileSource;
            if (item instanceof OpenSeadragon.TiledImage) {
                tileSource = item.source;
            } else if (item instanceof OpenSeadragon.TileSource) {
                tileSource = item;
            } else if (item instanceof Number) {
                tileSource = this.viewer.world.getItemAt(item);
            } else {
                throw new Error(`Invalid argument ${item}! The type of argument must be TiledImage, TileSource, or Number!`);
            }

            // TiledImage has already been configured
            if (!shaders && tileSource.__renderInfo !== undefined) {
                return tileSource.__renderInfo;
            }

            const info = tileSource.__renderInfo = {
                id: null,
                externalId: null,
                sources: null,
                shaders: null,
                drawers: null
            };

            info.id = Date.now();
            info.externalId = externalId;

            // the array containing numbers representing rendering order of the data sources:
            //  example: [4, 1, 3, 2, 0] -> the fourth data source should be rendered first and the first data source should be rendered last
            info.sources = orderOfDataSources;

            // object containing settings for rendering individual data sources:
            //  example: {0: {<rendering settings for first data source>, 1: {...}, 2: {...}, 3: {...}, 4: {<rendering settings for the last data source>}}
            info.shaders = {};
            if (shaders) {
                // IMPORTANT, shaderID is a string, because <shaders> object is in JSON notation.
                // So, with Object.keys(shaders) we get an order of shaderIDs in the order in which they were added.
                // Which is wanted, because the order of adding objects to <shaders> defines which object to use as rendering settings for which data source.
                // As a result, it is irrelevant what the shaderID is, because it is the order of adding objects to <shaders> that defines for which data source the object is used. The first added object is used for the first data source, the second added object is used for the second data source, and so on...
                let i = 0;
                for (const shaderID of Object.keys(shaders)) {
                    const shaderConfig = shaders[shaderID];

                    // tell that with this shader we want to render the i-th data source
                    info.shaders[i++] = {
                        originalShaderConfig: shaderConfig,
                    };
                }

            } else { // manually define rendering settings for the TiledImage, assume one data source only
                let shaderType = "identity";
                // if (tileSource.tilesUrl === 'https://openseadragon.github.io/example-images/duomo/duomo_files/') {
                //     shaderType = "edgeNotPlugin";
                // } else if (tileSource._id === "http://localhost:8000/test/data/iiif_2_0_sizes") {
                //     shaderType = "negative";
                // }

                info.shaders[0] = {
                    originalShaderConfig: {
                        name: shaderType + " shader",
                        type: shaderType,
                        visible: 1,
                        fixed: false,
                        dataReferences: [0],
                        params: {},
                        cache: {},
                        _cacheApplied: undefined
                    },
                    // shaderID: info.id.toString() + '_0',
                    // externalId: externalId + '_0'
                };
            }

            // TiledImage is shared between WebGLDrawerModular instantions (main canvas, minimap, maybe more in the future...),
            // so, every individual instantion can put it's own data here. The instantion's _id should serve as the key into this map.
            info.drawers = {};

            return info;
        }

        /**
         * Register TiledImage into the system.
         * @param {OpenSeadragon.TiledImage} tiledImage
         */
        tiledImageCreated(tiledImage) {
            const tiledImageInfo = this.configureTiledImage(tiledImage);

            // settings is an object holding the TiledImage's data sources' rendering settings
            let settings = {
                shaders: {},                // {dataSourceIndex: {<rendering settings>}}
                _utilizeLocalMethods: false // whether the TiledImage should be rendered using two-pass rendering
            };

            // TODO what is sources???
            for (const sourceIndex of tiledImageInfo.sources) {
                // do not touch the original incoming object, rather copy the parameters needed
                const originalShaderConfig = tiledImageInfo.shaders[sourceIndex].originalShaderConfig;
                const shaderID = tiledImageInfo.id.toString() + '_' + sourceIndex.toString();
                const shaderExternalID = tiledImageInfo.externalId.toString() + '_' + sourceIndex.toString();
                const shaderName = originalShaderConfig.name;
                const shaderType = originalShaderConfig.type;
                const shaderVisible = originalShaderConfig.visible;
                const shaderFixed = originalShaderConfig.fixed;
                const shaderParams = originalShaderConfig.params;
                const shaderCache = originalShaderConfig._cacheApplied ? originalShaderConfig.cache : {};

                // shaderConfig is an object holding the rendering settings of the concrete TiledImage's data source. Based on this object, the ShaderLayer instantion is created.
                let shaderConfig = {};
                shaderConfig.id = shaderID;
                shaderConfig.externalId = shaderExternalID;
                shaderConfig.name = shaderName;
                // corresponds to the return value of wanted ShaderLayer's type() method
                shaderConfig.type = shaderType;
                shaderConfig.visible = shaderVisible;
                shaderConfig.fixed = shaderFixed;
                // object holding ShaderLayer's settings
                // todo ability to reference other tile sources
                Object.defineProperty(shaderConfig, "dataReferences", {
                    get: () => [this.viewer.world.getIndexOfItem(tiledImage)]
                });

                shaderConfig.params = shaderParams;
                // object holding ShaderLayer's controls
                shaderConfig._controls = {};
                // cache object used by the ShaderLayer's controls
                shaderConfig._cache = shaderCache;

                if (!shaderConfig.params.use_blend && tiledImage.compositeOperation) {
                    // eslint-disable-next-line camelcase
                    shaderConfig.params.use_mode = 'mask';
                    // eslint-disable-next-line camelcase
                    shaderConfig.params.use_blend = tiledImage.compositeOperation;
                }

                // todo rebuild shaders once done in the for loop
                const shader = this.renderer.createShaderLayer(shaderConfig);
                shaderConfig._renderContext = shader;
                shaderConfig.rendering = true;

                // if the ShaderLayer requieres neighbor pixel access, tell that this TiledImage should be rendered using two-pass rendering
                if (shaderType === "edgeNotPlugin") {
                    settings._utilizeLocalMethods = true;
                }
                // add rendering settings for sourceIndex-th data source to the settings object
                settings.shaders[sourceIndex] = shaderConfig;
            }

            // add the settings object to the tiledImageInfo.drawers object using this._id as the key, ensuring that the TiledImage settings are not overwritten by another instance of WebGLDrawerModular
            tiledImageInfo.drawers[this._id] = settings;

            this.renderer.setShaderLayerOrder(this.viewer.world._items.map(item =>
                Object.values(item.source.__renderInfo.drawers[this._id].shaders).map(shaderConf => shaderConf.id)
            ).flat());
            console.log(this.renderer._shadersOrder);
            // reinitialize offScreenTextures (new layers probably need to be added)
            // todo too complex storage of metadata
            this._initializeOffScreenTextures();
            // todo do force recompilation each time, do it when necessary, dirty, make 'soft delete'
            this.renderer.setDimensions(0, 0, this.canvas.width, this.canvas.height, this.viewer.world.getItemCount());
            // todo privates touching
            this._requestRebuild();

            // update object holding session settings
            const tI = this._sessionInfo[tiledImageInfo.externalId] = {};
            tI.sources = tiledImageInfo.sources;
            tI.shaders = tiledImageInfo.shaders;
            tI.controlsCaches = {};
            for (const sourceIndex in tiledImageInfo.drawers[this._id].shaders) {
                tI.controlsCaches[sourceIndex] = tiledImageInfo.drawers[this._id].shaders[sourceIndex]._cache;
            }

            tiledImage.addHandler('composite-operation-change', e => {
                for (let sid in settings.shaders) {
                    // todo consider just removing 'show' and using 'mask' by default with correct blending
                    // eslint-disable-next-line camelcase
                    settings.shaders[sid].params.use_blend = tiledImage.compositeOperation;
                    // eslint-disable-next-line camelcase
                    settings.shaders[sid].params.use_mode = 'mask';
                    // todo we cannot just change prop -> use layer class to control, or reflect changes immediatelly!
                    settings.shaders[sid]._renderContext.resetMode(settings.shaders[sid].params);
                }
                this._requestRebuild(0);
            });
        }

        _requestRebuild(timeout = 30) {
            if (this._rebuildStamp) {
                return;
            }
            this._rebuildStamp = setTimeout(() => {
                //todo internals touching
                this.renderer.registerProgram(null, this.renderer.webglContext.secondPassProgramKey);
                this._rebuildStamp = null;
            }, timeout);
        }

        /**
         * Initial setup of all three canvases used (output, clipping, rendering) and their contexts (2d, 2d, webgl)
         */
        _setupCanvases() {
            this._outputCanvas = this.canvas; //canvas on screen
            this._outputContext = this._outputCanvas.getContext('2d');

            this._renderingCanvas = this.renderer.canvas; //canvas for webgl
            this._gl = this.renderer.gl;

            this._clippingCanvas = document.createElement('canvas'); //canvas for clipping and cropping
            this._clippingContext = this._clippingCanvas.getContext('2d');

            this._renderingCanvas.width = this._clippingCanvas.width = this._outputCanvas.width;
            this._renderingCanvas.height = this._clippingCanvas.height = this._outputCanvas.height;

            this._resizeHandler = () => {
                if(this._outputCanvas !== this.viewer.drawer.canvas) {
                    this._outputCanvas.style.width = this.viewer.drawer.canvas.clientWidth + 'px';
                    this._outputCanvas.style.height = this.viewer.drawer.canvas.clientHeight + 'px';
                }

                let viewportSize = this._calculateCanvasSize();
                if (this.debug) {
                    console.info('Resize event, newWidth, newHeight:', viewportSize.x, viewportSize.y);
                }

                if( this._outputCanvas.width !== viewportSize.x ||
                    this._outputCanvas.height !== viewportSize.y ) {
                    this._outputCanvas.width = viewportSize.x;
                    this._outputCanvas.height = viewportSize.y;
                }

                this._renderingCanvas.style.width = this._outputCanvas.clientWidth + 'px';
                this._renderingCanvas.style.height = this._outputCanvas.clientHeight + 'px';
                this._renderingCanvas.width = this._clippingCanvas.width = this._outputCanvas.width;
                this._renderingCanvas.height = this._clippingCanvas.height = this._outputCanvas.height;

                this.renderer.setDimensions(0, 0, viewportSize.x, viewportSize.y, this.viewer.world.getItemCount());
                this._layerCount = this.viewer.world.getItemCount(); // todo each tiled image can carry N objects, we need to split these
                this._size = viewportSize;

                // reinitialize offScreenTextures (size of the textures needs to be changed)
                this._initializeOffScreenTextures();
            };
            this.viewer.addHandler("resize", this._resizeHandler);
        }

        // OFF-SCREEN TEXTURES MANAGEMENT

        /**
         * Initialize off-screen textures used as a render target for the first-pass during the two-pass rendering.
         * Called from this.tiledImageCreated() method (number of layers has to be changed),
         * and during "resize" event (size of the layers has to be changed).
         */
        _initializeOffScreenTextures() {
            //todo delete

            // const gl = this._gl;
            // const x = this._size.x;
            // const y = this._size.y;
            // const numOfTextures = this._offScreenTexturesCount;
            //
            // if (this.webGLVersion === "1.0") {
            //     for (let i = 0; i < numOfTextures; ++i) {
            //
            //         let texture = this._offScreenTextures[i];
            //         if (!texture) {
            //             this._offScreenTextures[i] = texture = gl.createTexture();
            //         }
            //         gl.bindTexture(gl.TEXTURE_2D, texture);
            //
            //         const initialData = new Uint8Array(x * y * 4);
            //
            //         gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, x, y, 0, gl.RGBA, gl.UNSIGNED_BYTE, initialData);
            //         gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            //         gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            //         gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            //         gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            //     }
            //
            // } else {
            //     gl.deleteTexture(this._offscreenTextureArray);
            //     this._offscreenTextureArray = gl.createTexture();
            //     gl.bindTexture(gl.TEXTURE_2D_ARRAY, this._offscreenTextureArray);
            //
            //     // once you allocate storage with gl.texStorage3D, you cannot change the textureArray's size or format, which helps optimize performance and ensures consistency
            //     gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, x, y, numOfTextures);
            //
            //     const initialData = new Uint8Array(x * y * 4);
            //     for (let i = 0; i < numOfTextures; ++i) {
            //         gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, x, y, 1, gl.RGBA, gl.UNSIGNED_BYTE, initialData);
            //     }
            //
            //     gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            //     gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            //     gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            //     gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            // }
        }

        // DRAWING METHODS
        /**
         * Draw using WebGLModule.
         * @param {[TiledImage]} tiledImages array of TiledImage objects to draw
         */
        draw(tiledImages) {
            const gl = this._gl;

            // clear the output canvas
            this._outputContext.clearRect(0, 0, this._outputCanvas.width, this._outputCanvas.height);

            // nothing to draw
            if (tiledImages.every(tiledImage => tiledImage.getOpacity() === 0 || tiledImage.getTilesToDraw().length === 0)) {
                return;
            }

            const bounds = this.viewport.getBoundsNoRotateWithMargins(true);
            let view = {
                bounds: bounds,
                center: new OpenSeadragon.Point(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
                rotation: this.viewport.getRotation(true) * Math.PI / 180,
                zoom: this.viewport.getZoom(true)
            };

            // TODO consider sending data and computing on GPU
            // calculate view matrix for viewer
            let flipMultiplier = this.viewport.flipped ? -1 : 1;
            let posMatrix = $.Mat3.makeTranslation(-view.center.x, -view.center.y);
            let scaleMatrix = $.Mat3.makeScaling(2 / view.bounds.width * flipMultiplier, -2 / view.bounds.height);
            let rotMatrix = $.Mat3.makeRotation(-view.rotation);
            let viewMatrix = scaleMatrix.multiply(rotMatrix).multiply(posMatrix);


            let useContext2DPipeline = this.viewer.compositeOperation || false;
            let twoPassRendering = false;
            // TODO do only with single pass
            // for (const tiledImage of tiledImages) {
            //     // use context2DPipeline if any tiledImage has compositeOperation, clip, crop or debugMode
            //     if (tiledImage.compositeOperation ||
            //         tiledImage._clip ||
            //         tiledImage._croppingPolygons ||
            //         tiledImage.debugMode) {
            //             useContext2DPipeline = true;
            //         }
            //
            //     // use two-pass rendering if any tiledImage (or tile in the tiledImage) has opacity lower than zero or if it utilizes local methods (looking at neighbor's pixels)
            //     if (tiledImage.getOpacity() < 1 ||
            //         (tiledImage.getTilesToDraw().length !== 0 && tiledImage.getTilesToDraw()[0].hasTransparency) ||
            //         tiledImage.source.__renderInfo.drawers[this._id]._utilizeLocalMethods) {
            //             twoPassRendering = true;
            //         }
            // }

            // use twoPassRendering also if context2DPipeline is used (as in original WebGLDrawer)
            // eslint-disable-next-line no-unused-vars
            twoPassRendering = twoPassRendering || useContext2DPipeline;

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.clear(gl.COLOR_BUFFER_BIT);

            // TODO uncomment! for testing
            // if (!twoPassRendering) {
            //     this._drawSinglePass(tiledImages, view, viewMatrix);
            // } else {
                this._drawTwoPass(tiledImages, view, viewMatrix, useContext2DPipeline);
            // }

            // data are still in the rendering canvas => draw them onto the output canvas and clear the rendering canvas
            if (this._renderingCanvasHasImageData) {
                this._outputContext.drawImage(this._renderingCanvas, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
                this._renderingCanvasHasImageData = false;
            }
        } // end of function

        /**
         * Draw all tiles' data sources directly into the rendering canvas using WebGLModule.
         * @param {[TiledImage]} tiledImages array of TiledImage objects to draw
         * @param {Object} viewport bounds, center, rotation, zoom
         * @param {OpenSeadragon.Mat3} viewMatrix
         */
        _drawSinglePass(tiledImages, viewport, viewMatrix) {
            tiledImages.forEach((tiledImage, tiledImageIndex) => {
                if (tiledImage.isTainted()) {
                    // // TODO: tained texture will fall back to webgl 1.0 rendering logics which will be less optimized, ont supported with 2.0

                    // first, draw any data left in the rendering buffer onto the output canvas
                    if(this._renderingCanvasHasImageData){
                        this._outputContext.drawImage(this._renderingCanvas, 0, 0);
                        this._renderingCanvasHasImageData = false;
                    }

                    // next, use the backup canvas drawer to draw this tainted image
                    const canvasDrawer = this._getBackupCanvasDrawer();
                    canvasDrawer.draw([tiledImage]);
                    this._outputContext.drawImage(canvasDrawer.canvas, 0, 0);

                } else {
                    const tilesToDraw = tiledImage.getTilesToDraw();
                    // nothing to draw
                    if (tilesToDraw.length === 0) {
                        return;
                    }

                    if (tiledImage.placeholderFillStyle && tiledImage._hasOpaqueTile === false) {
                        this._drawPlaceholder(tiledImage);
                    }

                    // get TILEDIMAGE MATRIX
                    let overallMatrix = viewMatrix;
                    let imageRotation = tiledImage.getRotation(true);
                    // if needed, handle the tiledImage being rotated
                    if( imageRotation % 360 !== 0) {
                        let imageRotationMatrix = $.Mat3.makeRotation(-imageRotation * Math.PI / 180);
                        let imageCenter = tiledImage.getBoundsNoRotate(true).getCenter();
                        let t1 = $.Mat3.makeTranslation(imageCenter.x, imageCenter.y);
                        let t2 = $.Mat3.makeTranslation(-imageCenter.x, -imageCenter.y);

                        // update the view matrix to account for this image's rotation
                        let localMatrix = t1.multiply(imageRotationMatrix).multiply(t2);
                        overallMatrix = viewMatrix.multiply(localMatrix);
                    }
                    let pixelSize = this._tiledImageViewportToImageZoom(tiledImage, viewport.zoom);


                    // ITERATE over TILES and DRAW them
                    for (let tileIndex = 0; tileIndex < tilesToDraw.length; ++tileIndex) {
                        const tile = tilesToDraw[tileIndex].tile;

                        const textureInfo = this.getDataToDraw(tile);
                        if (!textureInfo) {
                            continue;
                        }

                        const renderInfo = {
                            transform: this._getTileMatrix(tile, tiledImage, overallMatrix),
                            zoom: viewport.zoom,
                            pixelSize: pixelSize,
                            globalOpacity: 1,   // during the single-pass rendering, the global opacity is always 1
                            textureCoords: textureInfo.position
                        };

                        // render data sources in the correct order
                        const shaders = tiledImage.source.__renderInfo.drawers[this._id].shaders;
                        for (const sourceIndex of tiledImage.source.__renderInfo.sources) {
                            const shaderLayer = shaders[sourceIndex]._renderContext;

                            const source = {
                                texture: textureInfo.texture,
                                index: sourceIndex
                            };

                            this.renderer.processData(renderInfo, shaderLayer, source);
                        } //end of for dataSources of tiles

                    } //end of for tiles of tilesToDraw
                } //end of tiledImage.isTainted condition
            }); //end of for tiledImage of tiledImages

            this._renderingCanvasHasImageData = true;
        } // end of function

        /**
         * During the first-pass draw all tiles' data sources into the corresponding off-screen textures using identity rendering,
         * excluding any image-processing operations or any rendering customizations.
         * During the second-pass draw from the off-screen textures into the rendering canvas,
         * applying the image-processing operations and rendering customizations.
         * @param {OpenSeadragon.TiledImage[]} tiledImages array of TiledImage objects to draw
         * @param {Object} viewport has bounds, center, rotation, zoom
         * @param {OpenSeadragon.Mat3} viewMatrix
         */
        _drawTwoPass(tiledImages, viewport, viewMatrix, useContext2DPipeline) {
            const gl = this._gl;
            // const skippedTiledImages = {};

            let firstPassOutput = {};

            // FIRST PASS (render things as they are into the corresponding off-screen textures)

            const TI_PAYLOAD = [];
            for (let tiledImageIndex in tiledImages) {
                const tiledImage = tiledImages[tiledImageIndex];
                const payload = [];


                const tilesToDraw = tiledImage.getTilesToDraw();
                //todo this should be enabled
                // if (tilesToDraw.length === 0 || tiledImage.getOpacity() === 0) {
                //     skippedTiledImages[tiledImageIndex] = true;
                //     continue;
                // }

                if (tiledImage.placeholderFillStyle && tiledImage._hasOpaqueTile === false) {
                    this._drawPlaceholder(tiledImage);
                }

                // MATRIX (TODO consider sending data and computing on GPU)
                let overallMatrix = viewMatrix;
                let imageRotation = tiledImage.getRotation(true);
                // if needed, handle the tiledImage being rotated
                if( imageRotation % 360 !== 0) {
                    let imageRotationMatrix = $.Mat3.makeRotation(-imageRotation * Math.PI / 180);
                    let imageCenter = tiledImage.getBoundsNoRotate(true).getCenter();
                    let t1 = $.Mat3.makeTranslation(imageCenter.x, imageCenter.y);
                    let t2 = $.Mat3.makeTranslation(-imageCenter.x, -imageCenter.y);

                    // update the view matrix to account for this image's rotation
                    let localMatrix = t1.multiply(imageRotationMatrix).multiply(t2);
                    overallMatrix = viewMatrix.multiply(localMatrix);
                }


                for (let tileIndex = 0; tileIndex < tilesToDraw.length; ++tileIndex) {
                    const tile = tilesToDraw[tileIndex].tile;

                    const tileInfo = this.getDataToDraw(tile);
                    if (!tileInfo) {
                        //TODO consider drawing some error if the tile is in erroneous state
                        continue;
                    }
                    // todo a bit dirty, but we will have to redefine the object anyway
                    tileInfo.transformMatrix = this._getTileMatrix(tile, tiledImage, overallMatrix);
                    tileInfo.index = tiledImageIndex;
                    payload.push(tileInfo);
                }

                let polygons;

                //TODO: osd could cache this.getBoundsNoRotate(current) which might be fired many times in rendering (possibly also other parts)
                if(tiledImage._croppingPolygons){
                    polygons = tiledImage._croppingPolygons.map(polygon => polygon.flatMap(coord => {
                        let point = tiledImage.imageToViewportCoordinates(coord.x, coord.y, true);
                        return [point.x, point.y];
                    }));
                } else {
                    polygons = [];
                }
                if(tiledImage._clip){
                    const polygon = [
                        {x: tiledImage._clip.x, y: tiledImage._clip.y},
                        {x: tiledImage._clip.x + tiledImage._clip.width, y: tiledImage._clip.y},
                        {x: tiledImage._clip.x + tiledImage._clip.width, y: tiledImage._clip.y + tiledImage._clip.height},
                        {x: tiledImage._clip.x, y: tiledImage._clip.y + tiledImage._clip.height},
                    ];
                    polygons.push(polygon.flatMap(coord => {
                        let point = tiledImage.imageToViewportCoordinates(coord.x, coord.y, true);
                        return [point.x, point.y];
                    }));
                }

                TI_PAYLOAD.push({
                    tiles: payload,
                    stencilPolygons: polygons,
                    _temp: overallMatrix
                });
            }
            // todo flatten render data
            firstPassOutput = this.renderer.firstPassProcessData(TI_PAYLOAD);

            // DEBUG; export the off-screen textures as canvases  TODO some more elegant view
            if (this.debug) {
                // wait for the GPU to finish rendering into the off-screen textures
                gl.finish();

                this._extractOffScreenTexture(firstPassOutput, this.viewer.world.getItemCount());
            }

            const sources = [];
            for (let tiledImageIndex in tiledImages) {
                const tiledImage = tiledImages[tiledImageIndex];
                // if (skippedTiledImages[tiledImageIndex]) {
                //     return;
                // }

                const renderInfo = {
                    zoom: viewport.zoom,
                    pixelSize: this._tiledImageViewportToImageZoom(tiledImage, viewport.zoom),
                    opacity: tiledImage.getOpacity(),
                    shaders: []
                };

                // todo a bit weird mapping, redesign
                const shaders = tiledImage.source.__renderInfo.drawers[this._id].shaders;
                for (const shaderKey of tiledImage.source.__renderInfo.sources) {  //todo order?
                    const shaderObject = shaders[shaderKey];
                    const shader = shaderObject._renderContext;

                    renderInfo.shaders.push(shader);
                }
                sources.push(renderInfo);
            }
            this.renderer.secondPassProcessData(firstPassOutput, sources);
            // flag that the data needs to be put to the output canvas and that the rendering canvas needs to be cleared
            this._renderingCanvasHasImageData = true;
        } // end of function

        /**
         * Get transform matrix that will be applied to tile.
         */
        _getTileMatrix(tile, tiledImage, viewMatrix){
            // compute offsets that account for tile overlap; needed for calculating the transform matrix appropriately
            // x, y, w, h in viewport coords

            // todo cache this
            let overlapFraction = this._calculateOverlapFraction(tile, tiledImage);
            let xOffset = tile.positionedBounds.width * overlapFraction.x;
            let yOffset = tile.positionedBounds.height * overlapFraction.y;

            let x = tile.positionedBounds.x + (tile.x === 0 ? 0 : xOffset);
            let y = tile.positionedBounds.y + (tile.y === 0 ? 0 : yOffset);
            let right = tile.positionedBounds.x + tile.positionedBounds.width - (tile.isRightMost ? 0 : xOffset);
            let bottom = tile.positionedBounds.y + tile.positionedBounds.height - (tile.isBottomMost ? 0 : yOffset);
            let w = right - x;
            let h = bottom - y;

            let matrix = new $.Mat3([
                w, 0, 0,
                0, h, 0,
                x, y, 1,
            ]);

            if (tile.flipped) {
                // flips the tile so that we see it's back
                const flipLeftAroundTileOrigin = $.Mat3.makeScaling(-1, 1);
                // tile's geometry stays the same so when looking at it's back we gotta reverse the logic we would normally use
                const moveRightAfterScaling = $.Mat3.makeTranslation(-1, 0);
                matrix = matrix.multiply(flipLeftAroundTileOrigin).multiply(moveRightAfterScaling);
            }

            let overallMatrix = viewMatrix.multiply(matrix);
            return overallMatrix.values;
        }

        /**
         * Get pixel size value.
         */
        _tiledImageViewportToImageZoom(tiledImage, viewportZoom) {
            var ratio = tiledImage._scaleSpring.current.value *
                tiledImage.viewport._containerInnerSize.x /
                tiledImage.source.dimensions.x;
            return ratio * viewportZoom;
        }


        // DEBUG + EXPORT METHODS
        /**
         * Return string in JSON format containing session info.
         * @returns {string}
         */
        export() {
            return JSON.stringify(this._sessionInfo);
        }

        /**
         * Extract texture data into the canvas in this.offScreenTexturesAsCanvases[index] for debugging purposes.
         * @returns
         */
        // Generated with ChatGPT, customized.
        _extractOffScreenTexture(fpOutput, length) {
            if (!this._debugCanvas) {
                return;
            }
            const gl = this._gl;
            const width = this._size.x;
            const height = this._size.y;

            // create a temporary framebuffer to read from the texture layer
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._extractionFB);
            this._debugCanvas.width = width;
            this._debugCanvas.height = height;
            this._debugIntermediate.width = width;
            this._debugIntermediate.height = height;

            const ctx = this._debugCanvas.getContext('2d');
            const contextIntermediate = this._debugIntermediate.getContext('2d');

            for (let index = 0; index < length; index++) {
               if (this.webGLVersion === "1.0") {
                   // attach the texture to the framebuffer
                   //TODO
                   // gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._offScreenTextures[index], 0);
               } else {
                   // attach the specific layer of the textureArray to the framebuffer todo make render debug info inside the renderer so we do not touch internals
                   gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, fpOutput.texture, 0, index);
               }

               // check if framebuffer is complete
               if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
                   console.error(`Framebuffer is not complete, could not extract offScreenTexture index ${index}`);
                   return;
               }

               // read pixels from the framebuffer
               const pixels = new Uint8ClampedArray(width * height * 4);  // RGBA format needed???
               gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

                const imageData = new ImageData(pixels, width, height);
               // copy pixel data into the canvas
               imageData.data.set(pixels);
               contextIntermediate.putImageData(imageData, 0, 0);
               ctx.drawImage(this._debugIntermediate, 0, 0);
           }
            // unbind and delete the framebuffer
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        }



        // FUNCTIONS TAKEN FROM ORIGINAL OPENSEADRAGON WEBGLDRAWER --- WITHOUT MODIFICATIONS
        /**
         * @returns {Boolean} true
         */
        canRotate() {
            return true;
        }

        /**
         * @returns {Boolean} true if canvas and webgl are supported
         */
        static isSupported() {
            let canvasElement = document.createElement('canvas');
            let webglContext = $.isFunction(canvasElement.getContext) &&
                        canvasElement.getContext('webgl');
            let ext = webglContext && webglContext.getExtension('WEBGL_lose_context');
            if (ext) {
                ext.loseContext();
            }
            return !!(webglContext);
        }

        /**
         * @param {TiledImage} tiledImage the tiled image that is calling the function
         * @returns {Boolean} Whether this drawer requires enforcing minimum tile overlap to avoid showing seams.
         * @private
         */
        minimumOverlapRequired(tiledImage) {
            // return true if the tiled image is tainted, since the backup canvas drawer will be used.
            return tiledImage.isTainted();
        }


        /**
         * Creates an HTML element into which will be drawn.
         * @private
         * @returns {HTMLCanvasElement} the canvas to draw into
         */
        _createDrawingElement() {
            let canvas = $.makeNeutralElement("canvas");
            let viewportSize = this._calculateCanvasSize();
            canvas.width = viewportSize.x;
            canvas.height = viewportSize.y;
            return canvas;
        }

        /**
         * Get the backup renderer (CanvasDrawer) to use if data cannot be used by webgl
         * Lazy loaded
         * @private
         * @returns {CanvasDrawer}
         */
        _getBackupCanvasDrawer(){
            if(!this._backupCanvasDrawer){
                this._backupCanvasDrawer = this.viewer.requestDrawer('canvas', {mainDrawer: false});
                this._backupCanvasDrawer.canvas.style.setProperty('visibility', 'hidden');
                this._backupCanvasDrawer.getSupportedDataFormats = () => this._supportedFormats;
                this._backupCanvasDrawer.getDataToDraw = this.getDataToDraw.bind(this);
            }

            return this._backupCanvasDrawer;
        }

        /**
         * Sets whether image smoothing is enabled or disabled.
         * @param {Boolean} enabled if true, uses gl.LINEAR as the TEXTURE_MIN_FILTER and TEXTURE_MAX_FILTER, otherwise gl.NEAREST
         */
        setImageSmoothingEnabled(enabled){
            if( this._imageSmoothingEnabled !== enabled ){
                this._imageSmoothingEnabled = enabled;
                this.setInternalCacheNeedsRefresh();
                this.viewer.forceRedraw();
            }
        }

        internalCacheCreate(cache, tile) {
            let tiledImage = tile.tiledImage;
            let gl = this._gl;
            let position;
            let data = cache.data;

            if (!tiledImage.isTainted()) {
                if((data instanceof CanvasRenderingContext2D) && $.isCanvasTainted(data.canvas)){
                    tiledImage.setTainted(true);
                    $.console.warn('WebGL cannot be used to draw this TiledImage because it has tainted data. Does crossOriginPolicy need to be set?');
                    this._raiseDrawerErrorEvent(tiledImage, 'Tainted data cannot be used by the WebGLDrawer. Falling back to CanvasDrawer for this TiledImage.');
                    this.setInternalCacheNeedsRefresh();
                } else {
                    let sourceWidthFraction, sourceHeightFraction;
                    if (tile.sourceBounds) {
                        sourceWidthFraction = Math.min(tile.sourceBounds.width, data.width) / data.width;
                        sourceHeightFraction = Math.min(tile.sourceBounds.height, data.height) / data.height;
                    } else {
                        sourceWidthFraction = 1;
                        sourceHeightFraction = 1;
                    }

                    let overlap = tiledImage.source.tileOverlap;
                    if (overlap > 0){
                        // calculate the normalized position of the rect to actually draw
                        // discarding overlap.
                        let overlapFraction = this._calculateOverlapFraction(tile, tiledImage); //todo cache

                        let left = (tile.x === 0 ? 0 : overlapFraction.x) * sourceWidthFraction;
                        let top = (tile.y === 0 ? 0 : overlapFraction.y) * sourceHeightFraction;
                        let right = (tile.isRightMost ? 1 : 1 - overlapFraction.x) * sourceWidthFraction;
                        let bottom = (tile.isBottomMost ? 1 : 1 - overlapFraction.y) * sourceHeightFraction;
                        position = new Float32Array([
                            left, bottom,
                            left, top,
                            right, bottom,
                            right, top
                        ]);
                    } else {
                        position = new Float32Array([
                            0, sourceHeightFraction,
                            0, 0,
                            sourceWidthFraction, sourceHeightFraction,
                            sourceWidthFraction, 0
                        ]);
                    }


                    // TODO inspect: valid settings? where 'sources' come from?
                    // const numOfDataSources = tiledImage.source.__renderInfo.sources.length;
                    const tileInfo = {
                        numOfDataSources: 1, // todo delete
                        position: position,
                        texture: null,
                    };

                    if (this.debug) {
                        tileInfo.debugTiledImage = tiledImage;
                        tileInfo.debugCanvas = data; //fixme possibly an image
                        tileInfo.debugId = this._tileIdCounter++;
                    }


                    try {
                        const texture = gl.createTexture();
                        gl.bindTexture(gl.TEXTURE_2D, texture);

                        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this._imageSmoothingEnabled ? this._gl.LINEAR : this._gl.NEAREST);
                        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this._imageSmoothingEnabled ? this._gl.LINEAR : this._gl.NEAREST);
                        //gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

                        // upload the image data into the texture
                        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
                        tileInfo.texture = texture;
                        return tileInfo;
                    } catch (e){
                        // Todo a bit dirty re-use of the tainted flag, but makes the code more stable
                        tiledImage.setTainted(true);
                        $.console.error('Error uploading image data to WebGL. Falling back to canvas renderer.', e);
                        this._raiseDrawerErrorEvent(tiledImage, 'Unknown error when uploading texture. Falling back to CanvasDrawer for this TiledImage.');
                        this.setInternalCacheNeedsRefresh();
                    }

                }
            }
            if (data instanceof Image) {
                const canvas = document.createElement( 'canvas' );
                canvas.width = data.width;
                canvas.height = data.height;
                const context = canvas.getContext('2d', { willReadFrequently: true });
                context.drawImage( data, 0, 0 );
                data = context;
            }
            if (data instanceof CanvasRenderingContext2D) {
                return data;
            }
            $.console.error("Unsupported data used for WebGL Drawer - probably a bug!");
            return {};
        }

        internalCacheFree(data) {
            if (data && data.texture) {
                this._gl.deleteTexture(data.texture);
                data.texture = null;
            }
        }


        /**
         * Draw a rect onto the output canvas for debugging purposes
         * @param {OpenSeadragon.Rect} rect
         */
        drawDebuggingRect(rect){
            let context = this._outputContext;
            context.save();
            context.lineWidth = 2 * $.pixelDensityRatio;
            context.strokeStyle = this.debugGridColor[0];
            context.fillStyle = this.debugGridColor[0];

            context.strokeRect(
                rect.x * $.pixelDensityRatio,
                rect.y * $.pixelDensityRatio,
                rect.width * $.pixelDensityRatio,
                rect.height * $.pixelDensityRatio
            );

            context.restore();
        } // unused

        _calculateOverlapFraction(tile, tiledImage) {
            let overlap = tiledImage.source.tileOverlap;
            let nativeWidth = tile.sourceBounds.width; // in pixels
            let nativeHeight = tile.sourceBounds.height; // in pixels
            let overlapWidth  = (tile.x === 0 ? 0 : overlap) + (tile.isRightMost ? 0 : overlap); // in pixels
            let overlapHeight = (tile.y === 0 ? 0 : overlap) + (tile.isBottomMost ? 0 : overlap); // in pixels
            let widthOverlapFraction = overlap / (nativeWidth + overlapWidth); // as a fraction of image including overlap
            let heightOverlapFraction = overlap / (nativeHeight + overlapHeight); // as a fraction of image including overlap
            return {
                x: widthOverlapFraction,
                y: heightOverlapFraction
            };
        }

        _drawPlaceholder(tiledImage){
            const bounds = tiledImage.getBounds(true);
            const rect = this.viewportToDrawerRectangle(tiledImage.getBounds(true));
            const context = this._outputContext;

            let fillStyle;
            if ( typeof tiledImage.placeholderFillStyle === "function" ) {
                fillStyle = tiledImage.placeholderFillStyle(tiledImage, context);
            }
            else {
                fillStyle = tiledImage.placeholderFillStyle;
            }

            this._offsetForRotation({degrees: this.viewer.viewport.getRotation(true)});
            context.fillStyle = fillStyle;
            context.translate(rect.x, rect.y);
            context.rotate(Math.PI / 180 * bounds.degrees);
            context.translate(-rect.x, -rect.y);
            context.fillRect(rect.x, rect.y, rect.width, rect.height);
            this._restoreRotationChanges();
        }


        // CONTEXT2DPIPELINE FUNCTIONS (from WebGLDrawer)
        /**
         * Draw data from the rendering canvas onto the output canvas, with clipping,
         * cropping and/or debug info as requested.
         * @private
         * @param {OpenSeadragon.TiledImage} tiledImage - the tiledImage to draw
         * @param {Array} tilesToDraw - array of objects containing tiles that were drawn
         */
        _applyContext2dPipeline(tiledImage, tilesToDraw, tiledImageIndex) {
            this._outputContext.save();

            // set composite operation; ignore for first image drawn
            this._outputContext.globalCompositeOperation = tiledImageIndex === 0 ? null : tiledImage.compositeOperation || this.viewer.compositeOperation;
            if (tiledImage._croppingPolygons || tiledImage._clip){
                this._renderToClippingCanvas(tiledImage);
                this._outputContext.drawImage(this._clippingCanvas, 0, 0);

            } else {
                this._outputContext.drawImage(this._renderingCanvas, 0, 0);
            }
            this._outputContext.restore();

            if(tiledImage.debugMode){
                const flipped = this.viewer.viewport.getFlip();
                if(flipped){
                    this._flip();
                }
                this._drawDebugInfo(tilesToDraw, tiledImage, flipped);
                if(flipped){
                    this._flip();
                }
            }
        }

        _setClip(){
            // no-op: called by _renderToClippingCanvas when tiledImage._clip is truthy
            // so that tests will pass.
        }

        _renderToClippingCanvas(item){
            this._clippingContext.clearRect(0, 0, this._clippingCanvas.width, this._clippingCanvas.height);
            this._clippingContext.save();
            if(this.viewer.viewport.getFlip()){
                const point = new $.Point(this.canvas.width / 2, this.canvas.height / 2);
                this._clippingContext.translate(point.x, 0);
                this._clippingContext.scale(-1, 1);
                this._clippingContext.translate(-point.x, 0);
            }

            if(item._clip){
                const polygon = [
                    {x: item._clip.x, y: item._clip.y},
                    {x: item._clip.x + item._clip.width, y: item._clip.y},
                    {x: item._clip.x + item._clip.width, y: item._clip.y + item._clip.height},
                    {x: item._clip.x, y: item._clip.y + item._clip.height},
                ];
                let clipPoints = polygon.map(coord => {
                    let point = item.imageToViewportCoordinates(coord.x, coord.y, true)
                        .rotate(this.viewer.viewport.getRotation(true), this.viewer.viewport.getCenter(true));
                    let clipPoint = this.viewportCoordToDrawerCoord(point);
                    return clipPoint;
                });
                this._clippingContext.beginPath();
                clipPoints.forEach( (coord, i) => {
                    this._clippingContext[i === 0 ? 'moveTo' : 'lineTo'](coord.x, coord.y);
                });
                this._clippingContext.clip();
                this._setClip();
            }
            if(item._croppingPolygons){
                let polygons = item._croppingPolygons.map(polygon => {
                    return polygon.map(coord => {
                        let point = item.imageToViewportCoordinates(coord.x, coord.y, true)
                            .rotate(this.viewer.viewport.getRotation(true), this.viewer.viewport.getCenter(true));
                        let clipPoint = this.viewportCoordToDrawerCoord(point);
                        return clipPoint;
                    });
                });
                this._clippingContext.beginPath();
                polygons.forEach((polygon) => {
                    polygon.forEach( (coord, i) => {
                        this._clippingContext[i === 0 ? 'moveTo' : 'lineTo'](coord.x, coord.y);
                    });
                });
                this._clippingContext.clip();
            }

            if(this.viewer.viewport.getFlip()){
                const point = new $.Point(this.canvas.width / 2, this.canvas.height / 2);
                this._clippingContext.translate(point.x, 0);
                this._clippingContext.scale(-1, 1);
                this._clippingContext.translate(-point.x, 0);
            }

            this._clippingContext.drawImage(this._renderingCanvas, 0, 0);

            this._clippingContext.restore();
        }

        /**
         * Set rotations for viewport & tiledImage
         * @private
         * @param {OpenSeadragon.TiledImage} tiledImage
         */
        _setRotations(tiledImage) {
            var saveContext = false;
            if (this.viewport.getRotation(true) % 360 !== 0) {
                this._offsetForRotation({
                    degrees: this.viewport.getRotation(true),
                    saveContext: saveContext
                });
                saveContext = false;
            }
            if (tiledImage.getRotation(true) % 360 !== 0) {
                this._offsetForRotation({
                    degrees: tiledImage.getRotation(true),
                    point: this.viewport.pixelFromPointNoRotate(
                        tiledImage._getRotationPoint(true), true),
                    saveContext: saveContext
                });
            }
        }

        _offsetForRotation(options) {
            var point = options.point ?
                options.point.times($.pixelDensityRatio) :
                this._getCanvasCenter();

            var context = this._outputContext;
            context.save();

            context.translate(point.x, point.y);
            context.rotate(Math.PI / 180 * options.degrees);
            context.translate(-point.x, -point.y);
        }

        _flip(options) {
            options = options || {};
            var point = options.point ?
            options.point.times($.pixelDensityRatio) :
            this._getCanvasCenter();
            var context = this._outputContext;

            context.translate(point.x, 0);
            context.scale(-1, 1);
            context.translate(-point.x, 0);
        }

        _drawDebugInfo( tilesToDraw, tiledImage, flipped) {
            for ( var i = tilesToDraw.length - 1; i >= 0; i-- ) {
                var tile = tilesToDraw[ i ].tile;
                try {
                    this._drawDebugInfoOnTile(tile, tilesToDraw.length, i, tiledImage, flipped);
                } catch(e) {
                    $.console.error(e);
                }
            }
        }

        _drawDebugInfoOnTile(tile, count, i, tiledImage, flipped) {

            var colorIndex = this.viewer.world.getIndexOfItem(tiledImage) % this.debugGridColor.length;
            var context = this.context;
            context.save();
            context.lineWidth = 2 * $.pixelDensityRatio;
            context.font = 'small-caps bold ' + (13 * $.pixelDensityRatio) + 'px arial';
            context.strokeStyle = this.debugGridColor[colorIndex];
            context.fillStyle = this.debugGridColor[colorIndex];

            this._setRotations(tiledImage);

            if(flipped){
                this._flip({point: tile.position.plus(tile.size.divide(2))});
            }

            context.strokeRect(
                tile.position.x * $.pixelDensityRatio,
                tile.position.y * $.pixelDensityRatio,
                tile.size.x * $.pixelDensityRatio,
                tile.size.y * $.pixelDensityRatio
            );

            var tileCenterX = (tile.position.x + (tile.size.x / 2)) * $.pixelDensityRatio;
            var tileCenterY = (tile.position.y + (tile.size.y / 2)) * $.pixelDensityRatio;

            // Rotate the text the right way around.
            context.translate( tileCenterX, tileCenterY );

            const angleInDegrees = this.viewport.getRotation(true);
            context.rotate( Math.PI / 180 * -angleInDegrees );

            context.translate( -tileCenterX, -tileCenterY );

            if( tile.x === 0 && tile.y === 0 ){
                context.fillText(
                    "Zoom: " + this.viewport.getZoom(),
                    tile.position.x * $.pixelDensityRatio,
                    (tile.position.y - 30) * $.pixelDensityRatio
                );
                context.fillText(
                    "Pan: " + this.viewport.getBounds().toString(),
                    tile.position.x * $.pixelDensityRatio,
                    (tile.position.y - 20) * $.pixelDensityRatio
                );
            }
            context.fillText(
                "Level: " + tile.level,
                (tile.position.x + 10) * $.pixelDensityRatio,
                (tile.position.y + 20) * $.pixelDensityRatio
            );
            context.fillText(
                "Column: " + tile.x,
                (tile.position.x + 10) * $.pixelDensityRatio,
                (tile.position.y + 30) * $.pixelDensityRatio
            );
            context.fillText(
                "Row: " + tile.y,
                (tile.position.x + 10) * $.pixelDensityRatio,
                (tile.position.y + 40) * $.pixelDensityRatio
            );
            context.fillText(
                "Order: " + i + " of " + count,
                (tile.position.x + 10) * $.pixelDensityRatio,
                (tile.position.y + 50) * $.pixelDensityRatio
            );
            context.fillText(
                "Size: " + tile.size.toString(),
                (tile.position.x + 10) * $.pixelDensityRatio,
                (tile.position.y + 60) * $.pixelDensityRatio
            );
            context.fillText(
                "Position: " + tile.position.toString(),
                (tile.position.x + 10) * $.pixelDensityRatio,
                (tile.position.y + 70) * $.pixelDensityRatio
            );

            if (this.viewport.getRotation(true) % 360 !== 0 ) {
                this._restoreRotationChanges();
            }
            if (tiledImage.getRotation(true) % 360 !== 0) {
                this._restoreRotationChanges();
            }

            context.restore();
        }

        _restoreRotationChanges() {
            var context = this._outputContext;
            context.restore();
        }

        /**
         * Get the canvas center.
         * @private
         * @returns {OpenSeadragon.Point} the center point of the canvas
         */
        _getCanvasCenter() {
            return new $.Point(this.canvas.width / 2, this.canvas.height / 2);
        }
    };

    OpenSeadragon.WebGLDrawerModular.numOfDrawers = 0;
}( OpenSeadragon ));
