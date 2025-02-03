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
            this.webGLOptions = this.options;
            this.debug = this.webGLOptions.debug || false;

            this._id = this.constructor.numOfDrawers++;
            this.webGLVersion = "2.0";

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
                refetchCallback: () => {},
                debug: this.debug,
            },
            this.webGLOptions,
            {
                // Do not allow override:
                uniqueId: "osd_" + this._id,
                webGLPreferredVersion: this.webGLVersion,
                canvasOptions: {
                    stencil: true
                }
            });
            this.renderer = new $.WebGLModule(rendererOptions);
            this.renderer.setDimensions(0, 0, this.canvas.width, this.canvas.height);
            this.renderer.init();
            this.renderer.setDataBlendingEnabled(true); // enable alpha blending


            // SETUP CANVASES
            this._size = new $.Point(this.canvas.width, this.canvas.height); // current viewport size, changed during resize event
            this._setupCanvases();
            this.context = this._outputContext; // API required by tests


            // SETUP TWO-PASS RENDERING attributes
            this._offScreenBuffer = this._gl.createFramebuffer();
            this._offScreenTexturesCount = 0;
            this._offScreenTexturesUnusedIndices = [];
            if (this.webGLVersion === "1.0") {
                this._offScreenTextures = []; // [TEXTURE_2D, TEXTURE_2D, ...]
            } else {
                this._offscreenTextureArray = this._gl.createTexture(); // TEXTURE_2D_ARRAY
            }


            // SETUP DEBUGGING attributes
            // map to save offScreenTextures as canvases for exporting {layerId: canvas}
            this.offScreenTexturesAsCanvases = {};
            // map to save tiles as canvases for exporting {tileId: canvas}
            this.tilesAsCanvases = {};

            // Create a link for downloading off-screen textures, or input image data tiles. Only for the main drawer, not the minimap.
            // Generated with ChatGPT, customized.
            if (this._id === 0 && this.debug) {
                const downloadLink = document.createElement('a');
                downloadLink.id = 'download-off-screen-textures';
                downloadLink.href = '#';  // make it a clickable link
                downloadLink.textContent = 'Download off-screen textures';

                const element = document.getElementById('panel-shaders');
                if (!element) {
                    console.warn('Element with id "panel-shaders" not found, appending download link for off-screen textures to body.');
                    document.body.appendChild(downloadLink);
                } else {
                    element.appendChild(downloadLink);
                }

                // add an event listener to trigger the download when clicked
                downloadLink.addEventListener('click', (event) => {
                    event.preventDefault();  // prevent the default anchor behavior
                    this._downloadOffScreenTextures();
                });

                const downloadLink2 = document.createElement('a');
                downloadLink2.id = 'download-tiles';
                downloadLink2.href = '#';  // make it a clickable link
                downloadLink2.textContent = 'Download tiles';

                if (!element) {
                    document.body.appendChild(downloadLink2);
                } else {
                    element.appendChild(downloadLink2);
                }

                // add an event listener to trigger the download when clicked
                downloadLink2.addEventListener('click', (event) => {
                    event.preventDefault();  // prevent the default anchor behavior
                    this._downloadTiles();
                });
            }

            // reject listening for the tile-drawing and tile-drawn events, which this drawer does not fire
            this.viewer.rejectEventHandler("tile-drawn", "The WebGLDrawer does not raise the tile-drawn event");
            this.viewer.rejectEventHandler("tile-drawing", "The WebGLDrawer does not raise the tile-drawing event");


            this.viewer.world.addHandler("remove-item", (e) => {
                // delete export info about this tiledImage
                delete this._sessionInfo[e.item.source.__renderInfo.externalId];

                for (const sourceID of Object.keys(e.item.source.__renderInfo.drawers[this._id].shaders)) {
                    const sourceJSON = e.item.source.__renderInfo.drawers[this._id].shaders[sourceID];
                    this.renderer.removeShader(sourceJSON);
                    this._offScreenTexturesUnusedIndices.push(sourceJSON._offScreenTextureIndex);
                }


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
            });
        } // end of constructor

        /**
         * Drawer type.
         * @returns {String}
         */
        getType() {
            return 'modular-webgl';
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


            // delete tiles' data
            this._unloadTextures();


            // delete off-screen textures
            if (this.webGLVersion === "1.0") {
                for (const texture of this._offScreenTextures) {
                    // can be null if the texture was removed
                    if (texture) {
                        gl.deleteTexture(texture);
                    }
                }
                this._offScreenTextures = [];
            } else {
                gl.deleteTexture(this._offscreenTextureArray);
                this._offscreenTextureArray = null;
            }
            this._offScreenTexturesCount = 0;
            this._offScreenTexturesUnusedIndices = [];
            gl.deleteFramebuffer(this._offScreenBuffer);
            this._offScreenBuffer = null;


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


            // unbind our event listeners from the viewer
            this.viewer.removeHandler("resize", this._resizeHandler);
            // this.viewer.world.removeHandler("remove-item", this._removeItemHandler); NOT USED

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
         * @returns {Number} TiledImageInfo.externalId
         * @returns {[Number]} TiledImageInfo.sources
         * @returns {Object} TiledImageInfo.shaders
         * @returns {Object} TiledImageInfo.drawers
         */
        configureTiledImage(item, externalId = Date.now(), shaders = undefined, orderOfDataSources = [0]) {
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
            if (tileSource.__renderInfo !== undefined) {
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
         * @param {TiledImage} tiledImage
         */
        tiledImageCreated(tiledImage) {
            const tiledImageInfo = this.configureTiledImage(tiledImage);

            // settings is an object holding the TiledImage's data sources' rendering settings
            let settings = {
                shaders: {},                // {dataSourceIndex: {<rendering settings>}}
                _utilizeLocalMethods: false // whether the TiledImage should be rendered using two-pass rendering
            };

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
                shaderConfig.params = shaderParams;
                // object holding ShaderLayer's controls
                shaderConfig._controls = {};
                // cache object used by the ShaderLayer's controls
                shaderConfig._cache = shaderCache;

                const shader = this.renderer.createShaderLayer(shaderConfig);
                shaderConfig._renderContext = shader;
                shaderConfig._offScreenTextureIndex = this._getOffScreenTextureIndex();
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

            // reinitialize offScreenTextures (new layers probably need to be added)
            this._initializeOffScreenTextures();


            // update object holding session settings
            const tI = this._sessionInfo[tiledImageInfo.externalId] = {};
            tI.sources = tiledImageInfo.sources;
            tI.shaders = tiledImageInfo.shaders;
            tI.controlsCaches = {};
            for (const sourceIndex in tiledImageInfo.drawers[this._id].shaders) {
                tI.controlsCaches[sourceIndex] = tiledImageInfo.drawers[this._id].shaders[sourceIndex]._cache;
            }
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

                this.renderer.setDimensions(0, 0, viewportSize.x, viewportSize.y);
                this._size = viewportSize;

                // reinitialize offScreenTextures (size of the textures needs to be changed)
                this._initializeOffScreenTextures();
            };
            this.viewer.addHandler("resize", this._resizeHandler);
        }

        // OFF-SCREEN TEXTURES MANAGEMENT
        /**
         * Method to possibly recycle used off-screen texture arrays indices.
         * This is useful for example when 5 TiledImages were added and thus 5 off-screen textures were created. Then 3 were removed; making three indices free.
         * And then 3 were added again; so the 3 free indices can be reused.
         * If they were not reused, the next off-screen texture would be created on index 6, making the texture array bigger than necessary.
         * Over time, this can lead to the off-screen texture array being bigger and bigger, having more and more unused indices.
         * @returns {Number} index to this._offScreenTextures array (WebGL 1.0) or to this._offscreenTextureArray's layer (WebGL 2.0)
         */
        _getOffScreenTextureIndex() {
            if (this._offScreenTexturesUnusedIndices.length > 0) {
                return this._offScreenTexturesUnusedIndices.pop();
            }
            return this._offScreenTexturesCount++;
        }

        /**
         * Initialize off-screen textures used as a render target for the first-pass during the two-pass rendering.
         * Called from this.tiledImageCreated() method (number of layers has to be changed),
         * and during "resize" event (size of the layers has to be changed).
         */
        _initializeOffScreenTextures() {
            const gl = this._gl;
            const x = this._size.x;
            const y = this._size.y;
            const numOfTextures = this._offScreenTexturesCount;

            if (this.webGLVersion === "1.0") {
                for (let i = 0; i < numOfTextures; ++i) {

                    let texture = this._offScreenTextures[i];
                    if (!texture) {
                        this._offScreenTextures[i] = texture = gl.createTexture();
                    }
                    gl.bindTexture(gl.TEXTURE_2D, texture);

                    const initialData = new Uint8Array(x * y * 4);

                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, x, y, 0, gl.RGBA, gl.UNSIGNED_BYTE, initialData);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                }

            } else {
                gl.deleteTexture(this._offscreenTextureArray);
                this._offscreenTextureArray = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D_ARRAY, this._offscreenTextureArray);

                // once you allocate storage with gl.texStorage3D, you cannot change the textureArray's size or format, which helps optimize performance and ensures consistency
                gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, x, y, numOfTextures);

                const initialData = new Uint8Array(x * y * 4);
                for (let i = 0; i < numOfTextures; ++i) {
                    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, x, y, 1, gl.RGBA, gl.UNSIGNED_BYTE, initialData);
                }

                gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            }
        }

        /**
         * Bind framebuffer to i-th texture from this_offScreenTextures [gl.TEXTURE_2D]
         *               or to i-th layer from this._offscreenTextureArray gl.TEXTURE_2D_ARRAY
         * @param {Number} i index of texture or texture layer to bind
         */
        _bindFrameBufferToOffScreenTexture(i) {
            const gl = this._gl;
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._offScreenBuffer);
            if (this.webGLVersion === "1.0") {
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._offScreenTextures[i], 0);
            } else {
                gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this._offscreenTextureArray, 0, i);
            }
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

                // calculate view matrix for viewer
                let flipMultiplier = this.viewport.flipped ? -1 : 1;
                let posMatrix = $.Mat3.makeTranslation(-view.center.x, -view.center.y);
                let scaleMatrix = $.Mat3.makeScaling(2 / view.bounds.width * flipMultiplier, -2 / view.bounds.height);
                let rotMatrix = $.Mat3.makeRotation(-view.rotation);
                let viewMatrix = scaleMatrix.multiply(rotMatrix).multiply(posMatrix);


                let useContext2DPipeline = this.viewer.compositeOperation || false;
                let twoPassRendering = false;
                for (const tiledImage of tiledImages) {
                    // use context2DPipeline if any tiledImage has compositeOperation, clip, crop or debugMode
                    if (tiledImage.compositeOperation ||
                        tiledImage._clip ||
                        tiledImage._croppingPolygons ||
                        tiledImage.debugMode) {
                            useContext2DPipeline = true;
                        }

                    // use two-pass rendering if any tiledImage (or tile in the tiledImage) has opacity lower than zero or if it utilizes local methods (looking at neighbor's pixels)
                    if (tiledImage.getOpacity() < 1 ||
                        (tiledImage.getTilesToDraw().length !== 0 && tiledImage.getTilesToDraw()[0].hasTransparency) ||
                        tiledImage.source.__renderInfo.drawers[this._id]._utilizeLocalMethods) {
                            twoPassRendering = true;
                        }
                }

                // use twoPassRendering also if context2DPipeline is used (as in original WebGLDrawer)
                twoPassRendering = twoPassRendering || useContext2DPipeline;

                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                gl.clear(gl.COLOR_BUFFER_BIT);
                if (!twoPassRendering) {
                    this._drawSinglePass(tiledImages, view, viewMatrix);
                } else {
                    this._drawTwoPass(tiledImages, view, viewMatrix, useContext2DPipeline);
                }

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
                                textures: textureInfo.textures,
                                texture2DArray: textureInfo.texture2DArray,
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
         * @param {[TiledImage]} tiledImages array of TiledImage objects to draw
         * @param {Object} viewport has bounds, center, rotation, zoom
         * @param {OpenSeadragon.Mat3} viewMatrix
         */
        _drawTwoPass(tiledImages, viewport, viewMatrix, useContext2DPipeline) {
            const gl = this._gl;
            const skippedTiledImages = {};

            // FIRST PASS (render things as they are into the corresponding off-screen textures)
            tiledImages.forEach((tiledImage, tiledImageIndex) => {
                if (tiledImage.isTainted()) {
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
                    if (tilesToDraw.length === 0 || tiledImage.getOpacity() === 0) {
                        skippedTiledImages[tiledImageIndex] = true;
                        return;
                    }

                    if (tiledImage.placeholderFillStyle && tiledImage._hasOpaqueTile === false) {
                        this._drawPlaceholder(tiledImage);
                    }

                    // MATRIX
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

                    // ITERATE over TILES' data sources
                    for (const sourceIndex of tiledImage.source.__renderInfo.sources) {
                        // enable rendering into the correct off-screen texture
                        this._bindFrameBufferToOffScreenTexture(tiledImage.source.__renderInfo.drawers[this._id].shaders[sourceIndex]._offScreenTextureIndex);
                        // clear the off-screen texture
                        gl.clear(gl.COLOR_BUFFER_BIT);

                        // ITERATE over TILES
                        for (let tileIndex = 0; tileIndex < tilesToDraw.length; ++tileIndex) {
                            const tile = tilesToDraw[tileIndex].tile;

                            const tileInfo = this.getDataToDraw(tile);
                            if (!tileInfo) {
                                continue;
                            }

                            const transformMatrix = this._getTileMatrix(tile, tiledImage, overallMatrix);
                            const source = {
                                textures: tileInfo.textures,
                                texture2DArray: tileInfo.texture2DArray,
                                index: sourceIndex
                            };

                            this.renderer.firstPassProcessData(tileInfo.position, transformMatrix, source);
                        } // end of TILES iteration
                    } // end of TILES' data sources iteration
                } // end of TiledImage.isTainted condition
            }); // end of TILEDIMAGES iteration

            // DEBUG; export the off-screen textures as canvases
            if (this.debug) {
                // wait for the GPU to finish rendering into the off-screen textures
                gl.finish();

                // reset the object that may hold some unnecessary old data
                this.offScreenTexturesAsCanvases = {};

                // put the offScreenTexture's data into the canvases to enable exporting it as an image
                tiledImages.forEach((tiledImage, tiledImageIndex) => {
                    if (skippedTiledImages[tiledImageIndex]) {
                        return;
                    }

                    const numOfSources = tiledImage.source.__renderInfo.sources.length;
                    tiledImage.source.__renderInfo.sources.forEach((value, i) => {
                        const textureIndex = tiledImage.source.__renderInfo.drawers[this._id].shaders[value]._offScreenTextureIndex;
                        const order = tiledImageIndex * numOfSources + i;

                        this._extractOffScreenTexture(textureIndex, order);
                    });
                });
            }


            // SECOND-PASS (render from the off-screen textures to rendering canvas)
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            if (useContext2DPipeline) {
                tiledImages.forEach((tiledImage, tiledImageIndex) => {
                    if (skippedTiledImages[tiledImageIndex]) {
                        return;
                    }

                    const renderInfo = {
                        transform: new Float32Array([2.0, 0.0, 0.0, 0.0, 2.0, 0.0, -1.0, -1.0, 1.0]),   // matrix to get clip space coords from unit coords (coordinates supplied in column-major order)
                        zoom: viewport.zoom,
                        pixelSize: this._tiledImageViewportToImageZoom(tiledImage, viewport.zoom),
                        globalOpacity: tiledImage.getOpacity(),
                        textureCoords: new Float32Array([0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0])       // cover the whole texture
                    };

                    const shaders = tiledImage.source.__renderInfo.drawers[this._id].shaders;
                    for (const shaderKey of tiledImage.source.__renderInfo.sources) {
                        const shaderObject = shaders[shaderKey];
                        const shader = shaderObject._renderContext;
                        const offScreenTextureIndex = shaderObject._offScreenTextureIndex;

                        const source = {
                            textures: this._offScreenTextures,
                            texture2DArray: this._offscreenTextureArray,
                            index: offScreenTextureIndex
                        };

                        this.renderer.processData(renderInfo, shader, source);
                    }

                    // draw from the rendering canvas onto the output canvas and clear the rendering canvas
                    this._applyContext2dPipeline(tiledImage, tiledImage.getTilesToDraw(), tiledImageIndex);
                    gl.clear(gl.COLOR_BUFFER_BIT);
                });

                // flag that the data was already put to the output canvas and that the rendering canvas was cleared
                this._renderingCanvasHasImageData = false;

            } else { // future extension = instanced rendering
                tiledImages.forEach((tiledImage, tiledImageIndex) => {
                    if (skippedTiledImages[tiledImageIndex]) {
                        return;
                    }

                    const renderInfo = {
                        transform: new Float32Array([2.0, 0.0, 0.0, 0.0, 2.0, 0.0, -1.0, -1.0, 1.0]),   // matrix to get clip space coords from unit coords (coordinates supplied in column-major order)
                        zoom: viewport.zoom,
                        pixelSize: this._tiledImageViewportToImageZoom(tiledImage, viewport.zoom),
                        globalOpacity: tiledImage.getOpacity(),
                        textureCoords: new Float32Array([0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0])       // cover the whole texture
                    };

                    const shaders = tiledImage.source.__renderInfo.drawers[this._id].shaders;
                    for (const shaderKey of tiledImage.source.__renderInfo.sources) {
                        const shaderObject = shaders[shaderKey];
                        const shader = shaderObject._renderContext;
                        const offScreenTextureIndex = shaderObject._offScreenTextureIndex;

                        const source = {
                            textures: this._offScreenTextures,
                            texture2DArray: this._offscreenTextureArray,
                            index: offScreenTextureIndex
                        };

                        this.renderer.processData(renderInfo, shader, source);
                    }
                }); // end of tiledImages for cycle

                // flag that the data needs to be put to the output canvas and that the rendering canvas needs to be cleared
                this._renderingCanvasHasImageData = true;
            } // end of not using context2DPipeline method
        } // end of function

        /**
         * Get transform matrix that will be applied to tile.
         */
        _getTileMatrix(tile, tiledImage, viewMatrix){
            // compute offsets that account for tile overlap; needed for calculating the transform matrix appropriately
            // x, y, w, h in viewport coords

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
                // implementation of the flipped feature uses backs of the tiles, need to disable culling
                this._gl.disable(this._gl.CULL_FACE);

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
         * Get tiles and off-screen textures as canvases for debugging purposes.
         * @returns {Object} debug data
         * @returns {Object} debugData.offScreenTextures    -> {id: Canvas}
         * @returns {Object} debugData.tile                 -> {id: Canvas}
         */
        getDebugData() {
            const data = {
                offScreenTextures: this.offScreenTexturesAsCanvases,
                tile: this.tilesAsCanvases
            };
            return data;
        }

        /**
         * @param {Object} data {id: Canvas}
         */
        _downloadOffScreenTextures(data) {
            if (!data) {
                data = this.offScreenTexturesAsCanvases;
            }

            for (const layerIndex in data) {
                const canvas = data[layerIndex].canvas;
                const order = data[layerIndex].order;
                canvas.toBlob(function(blob) {
                    const link = document.createElement('a');
                    // eslint-disable-next-line compat/compat
                    link.href = URL.createObjectURL(blob);
                    link.download = `offScreenTexture_renderedOrder=${order}_layerIndex=${layerIndex}.png`;
                    link.click();
                }, 'image/png');
            }
        }

        /**
         * @param {Object} data {id: Canvas}
         */
        _downloadTiles(data) {
            if (!data) {
                data = this.tilesAsCanvases;
            }

            for (const tileId in data) {
                const canvas = data[tileId];
                canvas.toBlob((blob) => {
                    const link = document.createElement('a');
                    // eslint-disable-next-line compat/compat
                    link.href = URL.createObjectURL(blob);
                    link.download = `tile${tileId}.png`;
                    link.click();
                }, 'image/png');
            }
        }

        /**
         * Extract texture data into the canvas in this.offScreenTexturesAsCanvases[index] for debugging purposes.
         * @param {number} index of the offScreenTexture in this._offScreenTextures or index of the layer in this._offscreenTextureArray
         * @param {number} order order in which was rendered into this offScreenTexture
         * @returns
         */
        // Generated with ChatGPT, customized.
        _extractOffScreenTexture(index, order) {
            const gl = this._gl;
            const width = this._size.x;
            const height = this._size.y;

            // create a temporary framebuffer to read from the texture layer
            const framebuffer = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);

            if (this.webGLVersion === "1.0") {
                // attach the texture to the framebuffer
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._offScreenTextures[index], 0);
            } else {
                // attach the specific layer of the textureArray to the framebuffer
                gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this._offscreenTextureArray, 0, index);
            }

            // check if framebuffer is complete
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
                console.error(`Framebuffer is not complete, could not extract offScreenTexture index ${index}`);
                return;
            }

            // read pixels from the framebuffer
            const pixels = new Uint8Array(width * height * 4);  // RGBA format needed???
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

            // unbind and delete the framebuffer
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.deleteFramebuffer(framebuffer);

            // use a canvas to convert raw pixel data to image
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            const imageData = ctx.createImageData(width, height);

            // copy pixel data into the canvas
            imageData.data.set(pixels);
            ctx.putImageData(imageData, 0, 0);

            // save the canvas and the rendering order in this.offScreenTexturesAsCanvases
            this.offScreenTexturesAsCanvases[index] = {
                canvas: canvas,
                order: order
            };
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
                    if(overlap > 0){
                        // calculate the normalized position of the rect to actually draw
                        // discarding overlap.
                        let overlapFraction = this._calculateOverlapFraction(tile, tiledImage);

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


                    const numOfDataSources = tiledImage.source.__renderInfo.sources.length;
                    const tileInfo = {
                        numOfDataSources: numOfDataSources, // number of data sources in the TiledImage
                        position: position,
                        textures: null,                // used with WebGL 1, [TEXTURE_2D]
                        texture2DArray: null           // used with WebGL 2, TEXTURE_2D_ARRAY
                    };

                    if (this.debug) {
                        tileInfo.debugTiledImage = tiledImage;
                        tileInfo.debugCanvas = data; //fixme possibly an image
                        tileInfo.debugId = this._tileIdCounter++;
                    }

                    // TODO: <MORE SOURCES FEATURE> In the future supply the data corresponding to it's source index, this puts one canvas everywhere.
                    if (this.webGLVersion === "1.0") {
                        const textureArray = [];


                        try {
                            for (let i = 0; i < numOfDataSources; ++i) {
                                const texture = gl.createTexture();
                                gl.bindTexture(gl.TEXTURE_2D, texture);

                                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this._imageSmoothingEnabled ? this._gl.LINEAR : this._gl.NEAREST);
                                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this._imageSmoothingEnabled ? this._gl.LINEAR : this._gl.NEAREST);

                                // upload the image data into the texture
                                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);

                                textureArray.push(texture);
                            }

                            tileInfo.textures = textureArray;
                            // if this is the main drawer (not the minimap) and debug is enabled, save the tile canvas for debugging
                            if (this.debug) {
                                // FIXME data could be an array, right now we just upload the only data item
                                this.tilesAsCanvases[tileInfo.debugId] = data;
                            }

                            return tileInfo;
                        } catch (e){
                            // Todo a bit dirty re-use of the tainted flag, but makes the code more stable
                            tiledImage.setTainted(true);
                            $.console.error('Error uploading image data to WebGL. Falling back to canvas renderer.', e);
                            this._raiseDrawerErrorEvent(tiledImage, 'Unknown error when uploading texture. Falling back to CanvasDrawer for this TiledImage.');
                            this.setInternalCacheNeedsRefresh();
                        }

                    } else { // WebGL 2.0
                        const texture2DArray = gl.createTexture();
                        gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture2DArray);

                        const x = data.width;
                        const y = data.height;

                        try {
                            gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, x, y, numOfDataSources);
                            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
                            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
                            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, this._imageSmoothingEnabled ? this._gl.LINEAR : this._gl.NEAREST);
                            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, this._imageSmoothingEnabled ? this._gl.LINEAR : this._gl.NEAREST);

                            // fill the data
                            for (let i = 0; i < numOfDataSources; ++i) {
                                gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, x, y, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
                            }
                            tileInfo.texture2DArray = texture2DArray;
                            // if this is the main drawer (not the minimap) and debug is enabled, save the tile canvas for debugging
                            if (this.debug) {
                                // FIXME data could be an array, right now we just upload the only data item
                                this.tilesAsCanvases[tileInfo.debugId] = data;
                            }
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
            if (data) {
                if (this.webGLVersion === "1.0" && data.textures) {
                    for (const texture of data.textures) {
                        this._gl.deleteTexture(texture);
                    }
                } else if (this.webGLVersion === "2.0" && data.texture2DArray) {
                    this._gl.deleteTexture(data.texture2DArray);
                }
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
