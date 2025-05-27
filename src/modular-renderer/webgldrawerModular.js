(function( $ ){
    const OpenSeadragon = $;

    /**
     * @typedef {Object} TiledImageInfo
     * @property {Number} TiledImageInfo.id
     * @property {Number[]} TiledImageInfo.shaderOrder
     * @property {Object} TiledImageInfo.shaders
     * @property {Object} TiledImageInfo.drawers
     */

    /**
     * @property {Number} idGenerator unique ID getter
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

            this._destroyed = false;
            // this._outputCanvas = null;
            // this._outputContext = null;
            // this._renderingCanvas = null;
            // this._renderingCanvasHasImageData = false;

            this._backupCanvasDrawer = null;
            this._imageSmoothingEnabled = false; // will be updated by setImageSmoothingEnabled
            this._configuredExternally = false;

            this._sessionInfo = {}; // attribute containing session info, used for exporting
            this._supportedFormats = ["blob", "context2d", "image"];

            // Create a link for downloading off-screen textures, or input image data tiles. Only for the main drawer, not the minimap.
            // Generated with ChatGPT, customized.
            if (this._id === 0 && this.debug) {
                const canvas = document.createElement("canvas");
                canvas.id = 'download-off-screen-textures';
                canvas.href = '#';  // make it a clickable link
                canvas.textContent = 'Download off-screen textures';

                const element = document.getElementById(this.options.debugInfoContainer); // todo dirty
                if (!element) {
                    console.warn('Element with id "panel-shaders" not found, appending download link for off-screen textures to body.');
                    document.body.appendChild(canvas);
                    canvas.style.position = 'absolute';
                    canvas.style.top = '0px';

                } else {
                    element.appendChild(canvas);
                }
                canvas.style.width = '250px';
                canvas.style.height = '250px';
                this._debugCanvas = canvas; //todo dirty
                this._extractionFB =  this.renderer.gl.createFramebuffer();
                this._debugIntermediate = document.createElement("canvas");

            }

            // reject listening for the tile-drawing and tile-drawn events, which this drawer does not fire
            this.viewer.rejectEventHandler("tile-drawn", "The WebGLDrawer does not raise the tile-drawn event");
            this.viewer.rejectEventHandler("tile-drawing", "The WebGLDrawer does not raise the tile-drawing event");
            this.viewer.world.addHandler("remove-item", (e) => {
                const tiledImage = e.item;
                // if managed internally on the instance (regardless of renderer state), handle removal
                if (tiledImage.__shaderConfig) {
                    this.renderer.removeShader(tiledImage.__shaderConfig.id);
                    delete tiledImage.__shaderConfig;
                    if (tiledImage.__wglCompositeHandler) {
                        tiledImage.removeHandler('composite-operation-change', tiledImage.__wglCompositeHandler);
                    }
                }
                // if now managed externally, just request rebuild, also updates order
                if (!this._configuredExternally) {
                    // Update keys
                    this._requestRebuild();
                }
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
                preloadCache: true,
                copyShaderConfig: false,
                debugInfoContainer: undefined
            };
        }

        /**
         * todo docs
         *
         * todo use in xopat instead of configuration
         * @param shaders
         * @param shaderOrder
         */
        setRenderingConfig(shaders, shaderOrder = undefined) {
            // todo reset also when reordering tiled images!
            // or we could change order only

            const willBeConfigured = !!shaders;
            if (!willBeConfigured) {
                if (this._configuredExternally) {
                    this._configuredExternally = false;
                    // If we changed render style, recompile everything
                    this.renderer.deleteShaders();
                    this.viewer.world._items.map(item => this.tiledImageCreated(item).id);
                }
                return;
            }

            // If custom rendering used, use arbitrary external configuration
            this._configuredExternally = true;
            this.renderer.deleteShaders();
            for (let shaderID in shaders) {
                let config = shaders[shaderID];
                this.setRenderingConfigShader(shaderID, config);
            }
            shaderOrder = shaderOrder || Object.keys(shaders);
            this.renderer.setShaderLayerOrder(shaderOrder);
            this._requestRebuild();
        }

        /**
         * If shaders are managed internally, tiled image can be configured a single custom
         * shader if desired. This shader is ignored if setRenderingConfig({...}) used.
         * @param tiledImage
         * @param shader
         */
        configureTiledImage(tiledImage, shader) {
            shader.id = shader.id || this.constructor.idGenerator;
            tiledImage.__shaderConfig = shader;

            // if already configured, request re-configuration
            if (tiledImage.__wglCompositeHandler) {
                this.tiledImageCreated(tiledImage);
            }
            return shader;
        }

        /**
         * Retrieve shader config by its key. Shader IDs are known only
         * when setRenderingConfig() called
         * @param key
         * @return {ShaderConfig|*|undefined}
         */
        getRenderingConfig(key) {
            const shaderLayer = this.renderer.getAllShaders()[key];
            return shaderLayer ? shaderLayer.getConfig() : undefined;
        }

        // todo better names
        setRenderingConfigShader(key, config) {
            const defaultConfig = {
                id: this.constructor.idGenerator,
                name: "Layer",
                type: "identity",
                visible: 1,
                fixed: false,
                tiledImages: [0],
                params: {},
                cache: {},
            };
            if (this.options.copyShaderConfig) {
                // Deep copy to avoid modification propagation
                config = $.extend(true, defaultConfig, config);
            } else {
                // Ensure we keep references where possible -> this will make shader object within drawers (e.g. navigator VS main)
                for (let propName in defaultConfig) {
                    if (config[propName] === undefined) {
                        config[propName] = defaultConfig[propName];
                    }
                }
            }
            config._renderContext = this.renderer.createShaderLayer(key, config);
        }

        /**
         * Register TiledImage into the system.
         * @param {OpenSeadragon.TiledImage} tiledImage
         * @return {ShaderConfig|null}
         */
        tiledImageCreated(tiledImage) {
            // Always attempt to clean up
            if (tiledImage.__wglCompositeHandler) {
                tiledImage.removeHandler('composite-operation-change', tiledImage.__wglCompositeHandler);
            }

            // If we configure externally the renderer, simply bypass
            if (this._configuredExternally) {
                // __shaderConfig reference is kept only when managed internally, can keep custom shader config for particular tiled image
                delete tiledImage.__shaderConfig;
                this._requestRebuild();
                return null;
            }

            let config = tiledImage.__shaderConfig;
            if (!config) {
                config = tiledImage.__shaderConfig = {
                    name: "Identity shader",
                    type: "identity",
                    visible: 1,
                    fixed: false,
                    params: {},
                    cache: {},
                };
            }

            if (!config.id) {
                config.id = this.constructor.idGenerator;
            }

            const shaderId = config.id;

            // When this._configuredExternally == false, the index is always self index, deduced dynamically
            const property = Object.getOwnPropertyDescriptor(config, 'tiledImages');
            if (!property || property.configurable) {
                delete config.tiledImages;

                // todo make custom renderer pass tiledImages as array of tiled images -> will deduce easily
                Object.defineProperty(config, "tiledImages", {
                    get: () => [this.viewer.world.getIndexOfItem(tiledImage)]
                });
            } // else already set as a getter


            if (!config.params.use_blend && tiledImage.compositeOperation) {
                // eslint-disable-next-line camelcase
                config.params.use_mode = 'mask';
                // eslint-disable-next-line camelcase
                config.params.use_blend = tiledImage.compositeOperation;
            }

            const shader = this.renderer.createShaderLayer(shaderId, config);
            config._renderContext = shader;

            tiledImage.__wglCompositeHandler = e => {
                // todo consider just removing 'show' and using 'mask' by default with correct blending

                const config = shader.getConfig();

                // eslint-disable-next-line camelcase
                config.params.use_blend = tiledImage.compositeOperation;
                // eslint-disable-next-line camelcase
                config.params.use_mode = 'mask';
                shader.resetMode(config.params, false);
                this._requestRebuild(0);
            };

            tiledImage.addHandler('composite-operation-change', tiledImage.__wglCompositeHandler);
            this._requestRebuild();
            return config;
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

                if (this.webGLVersion === "2.0") {
                    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
                }
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);


            // this._outputCanvas.width = this._outputCanvas.height = 1;
            // this._renderingCanvas.width = this._renderingCanvas.height = 1;
            // this._outputCanvas = this._outputContext = null;

            // this._renderingCanvas = null;
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

        _hasInvalidBuildState() {
            return this._requestBuildStamp > this._buildStamp;
        }

        _requestRebuild(timeout = 30, force = false) {
            this._requestBuildStamp = Date.now();
            if (this._rebuildHandle) {
                if (!force) {
                    return;
                }
                clearTimeout(this._rebuildHandle);
            }
            this._rebuildHandle = setTimeout(() => {
                if (!this._configuredExternally) {
                    this.renderer.setShaderLayerOrder(this.viewer.world._items.map(item =>
                        item.__shaderConfig.id));
                }
                this._buildStamp = Date.now();

                //todo internals touching
                this.renderer.setDimensions(0, 0, this.canvas.width, this.canvas.height, this.viewer.world.getItemCount());
                // this.renderer.registerProgram(null, this.renderer.webglContext.firstPassProgramKey);
                this.renderer.registerProgram(null, this.renderer.webglContext.secondPassProgramKey);
                this._rebuildHandle = null;
                setTimeout(() => {
                    this.viewer.world.needsDraw();
                });
            }, timeout);
        }

        /**
         * Initial setup of all three canvases used (output, rendering) and their contexts (2d, 2d, webgl)
         */
        _setupCanvases() {
            // this._outputCanvas = this.canvas; //canvas on screen
            // this._outputContext = this._outputCanvas.getContext('2d');

            // this._renderingCanvas = this.renderer.canvas; //canvas for webgl

            // this._renderingCanvas.width = this._outputCanvas.width;
            // this._renderingCanvas.height = this._outputCanvas.height;

            this._resizeHandler = () => {
                // if(this._outputCanvas !== this.viewer.drawer.canvas) {
                //     this._outputCanvas.style.width = this.viewer.drawer.canvas.clientWidth + 'px';
                //     this._outputCanvas.style.height = this.viewer.drawer.canvas.clientHeight + 'px';
                // }

                let viewportSize = this._calculateCanvasSize();
                if (this.debug) {
                    console.info('Resize event, newWidth, newHeight:', viewportSize.x, viewportSize.y);
                }

                // if( this._outputCanvas.width !== viewportSize.x ||
                //     this._outputCanvas.height !== viewportSize.y ) {
                //     this._outputCanvas.width = viewportSize.x;
                //     this._outputCanvas.height = viewportSize.y;
                // }

                // todo necessary?
                // this._renderingCanvas.style.width = this._outputCanvas.clientWidth + 'px';
                // this._renderingCanvas.style.height = this._outputCanvas.clientHeight + 'px';
                // this._renderingCanvas.width = this._outputCanvas.width;
                // this._renderingCanvas.height = this._outputCanvas.height;

                this.renderer.setDimensions(0, 0, viewportSize.x, viewportSize.y, this.viewer.world.getItemCount());
                this._size = viewportSize;
            };
            this.viewer.addHandler("resize", this._resizeHandler);
        }

        // DRAWING METHODS
        /**
         * Draw using WebGLModule.
         * @param {[TiledImage]} tiledImages array of TiledImage objects to draw
         */
        draw(tiledImages) {
            // If we did not rebuild yet, avoid rendering - invalid program
            if (this._hasInvalidBuildState()) {
                this.viewer.world.needsDraw(); //todo maybe force rebuild now and continue?
                return;
            }
            const gl = this._gl;

            // clear the output canvas
            // this._outputContext.clearRect(0, 0, this._outputCanvas.width, this._outputCanvas.height);

            // nothing to draw
            if (tiledImages.every(tiledImage => tiledImage.getOpacity() === 0 || tiledImage.getTilesToDraw().length === 0)) {
                // todo internal, maybe run second pass with empty once
                this.renderer.gl.clear(gl.COLOR_BUFFER_BIT);
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
            // let twoPassRendering = false;
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
            //         tiledImage.source.__renderInfo.drawers[this._id]._utilizeLocalMethods) {  //todo _utilizeLocalMethods discarded, .drawers too
            //             twoPassRendering = true;
            //         }
            // }

            // use twoPassRendering also if context2DPipeline is used (as in original WebGLDrawer)
            // eslint-disable-next-line no-unused-vars
            // twoPassRendering = twoPassRendering || useContext2DPipeline;


            // TODO
            //  WebGL2 supports only two pass rendering without any debug info etc.
            //       todo clipping polygons are not supported of concave! fix
            //  WebGL1 should be implemented to support only single pass render
            //       -> iterate over filed images
            //       -> support debug info, tained canvas data & c2d pipeline
            //       -> draw using stencil test, swap tile render order
            //       -> hmm, but then we do not deliver all the functionality

            // if (!twoPassRendering) {
            //     this._drawSinglePass(tiledImages, view, viewMatrix);
            // } else {
            this._drawTwoPass(tiledImages, view, viewMatrix, useContext2DPipeline);
            // }

            // Todo enable this as an optional feature
            // data are still in the rendering canvas => draw them onto the output canvas and clear the rendering canvas
            // if (this._renderingCanvasHasImageData) {
            //     this._outputContext.drawImage(this._renderingCanvas, 0, 0);
            //     gl.clear(gl.COLOR_BUFFER_BIT);
            //     this._renderingCanvasHasImageData = false;
            // }
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
                    // if(this._renderingCanvasHasImageData){
                    //     this._outputContext.drawImage(this._renderingCanvas, 0, 0);
                    //     this._renderingCanvasHasImageData = false;
                    // }

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
                            transform: this._updateTileMatrix(textureInfo, tile, tiledImage, overallMatrix),
                            zoom: viewport.zoom,
                            pixelSize: pixelSize,
                            globalOpacity: 1,   // during the single-pass rendering, the global opacity is always 1
                            textureCoords: textureInfo.position
                        };

                        // render data sources in the correct order
                        // todo __renderInfo deleted and .drawers too
                        const shaders = tiledImage.source.__renderInfo.drawers[this._id].shaders;
                        for (const sourceIndex of tiledImage.source.__renderInfo.shaderOrder) {
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

            // this._renderingCanvasHasImageData = true;
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
            for (let tiledImageIndex = 0; tiledImageIndex < tiledImages.length; tiledImageIndex++) {
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

                let overallMatrix = viewMatrix;
                let imageRotation = tiledImage.getRotation(true);
                // if needed, handle the tiledImage being rotated

                // todo consider in-place multiplication, this creates insane amout of arrays
                if( imageRotation % 360 !== 0) {
                    let imageRotationMatrix = $.Mat3.makeRotation(-imageRotation * Math.PI / 180);
                    let imageCenter = tiledImage.getBoundsNoRotate(true).getCenter();
                    let t1 = $.Mat3.makeTranslation(imageCenter.x, imageCenter.y);
                    let t2 = $.Mat3.makeTranslation(-imageCenter.x, -imageCenter.y);

                    // update the view matrix to account for this image's rotation
                    let localMatrix = t1.multiply(imageRotationMatrix).multiply(t2);
                    overallMatrix = viewMatrix.multiply(localMatrix);
                }

                console.log("TIled IMAGE", tiledImageIndex, "DRAWS TILES", tilesToDraw.length);
                for (let tileIndex = 0; tileIndex < tilesToDraw.length; ++tileIndex) {
                    const tile = tilesToDraw[tileIndex].tile;

                    const tileInfo = this.getDataToDraw(tile);
                    if (!tileInfo) {
                        //TODO consider drawing some error if the tile is in erroneous state
                        continue;
                    }
                    payload.push({
                        transformMatrix: this._updateTileMatrix(tileInfo, tile, tiledImage, overallMatrix),
                        dataIndex: tiledImageIndex,
                        texture: tileInfo.texture,
                        position: tileInfo.position,
                        tile: tile

                    });
                }

                let polygons;

                //TODO: osd could cache this.getBoundsNoRotate(current) which might be fired many times in rendering (possibly also other parts)
                if (tiledImage._croppingPolygons) {
                    polygons = tiledImage._croppingPolygons.map(polygon => polygon.flatMap(coord => {
                        let point = tiledImage.imageToViewportCoordinates(coord.x, coord.y, true);
                        return [point.x, point.y];
                    }));
                } else {
                    polygons = [];
                }
                if (tiledImage._clip) {
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
                    polygons: polygons,
                    dataIndex: tiledImageIndex,
                    _temp: overallMatrix, // todo dirty
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
            const shaders = this.renderer.getAllShaders();

            for (let shaderID of this.renderer.getShaderLayerOrder()) {
                const shader = shaders[shaderID];
                const config = shader.getConfig();

                // Here we could do some nicer logics, RN we just treat TI0 as a source of truth
                const tiledImage = this.viewer.world.getItemAt(config.tiledImages[0]);
                sources.push({
                    zoom: viewport.zoom,
                    pixelSize: this._tiledImageViewportToImageZoom(tiledImage, viewport.zoom),
                    opacity: tiledImage.getOpacity(),
                    shader: shader
                });
            }
            this.renderer.secondPassProcessData(firstPassOutput, sources);
            // flag that the data needs to be put to the output canvas and that the rendering canvas needs to be cleared
            this._renderingCanvasHasImageData = true;
            gl.finish();
        } // end of function

        _getTileRenderMeta(tile, tiledImage) {
            let result = tile._renderStruct;
            if (result) {
                return result;
            }

            // Overlap fraction of tile if set
            let overlap = tiledImage.source.tileOverlap;
            if (overlap > 0) {
                let nativeWidth = tile.sourceBounds.width; // in pixels
                let nativeHeight = tile.sourceBounds.height; // in pixels
                let overlapWidth  = (tile.x === 0 ? 0 : overlap) + (tile.isRightMost ? 0 : overlap); // in pixels
                let overlapHeight = (tile.y === 0 ? 0 : overlap) + (tile.isBottomMost ? 0 : overlap); // in pixels
                let widthOverlapFraction = overlap / (nativeWidth + overlapWidth); // as a fraction of image including overlap
                let heightOverlapFraction = overlap / (nativeHeight + overlapHeight); // as a fraction of image including overlap
                tile._renderStruct = result = {
                    overlapX: widthOverlapFraction,
                    overlapY: heightOverlapFraction
                };
            } else {
                tile._renderStruct = result = {
                    overlapX: 0,
                    overlapY: 0
                };
            }

            return result;
        }

        /**
         * Get transform matrix that will be applied to tile.
         */
        _updateTileMatrix(tileInfo, tile, tiledImage, viewMatrix){
            let tileMeta = this._getTileRenderMeta(tile, tiledImage);
            let xOffset = tile.positionedBounds.width * tileMeta.overlapX;
            let yOffset = tile.positionedBounds.height * tileMeta.overlapY;

            let x = tile.positionedBounds.x + (tile.x === 0 ? 0 : xOffset);
            let y = tile.positionedBounds.y + (tile.y === 0 ? 0 : yOffset);
            let right = tile.positionedBounds.x + tile.positionedBounds.width - (tile.isRightMost ? 0 : xOffset);
            let bottom = tile.positionedBounds.y + tile.positionedBounds.height - (tile.isBottomMost ? 0 : yOffset);

            const model = new $.Mat3([
                right - x, 0, 0, // sx = width
                0, bottom - y, 0, // sy = height
                x, y, 1
            ]);

            if (tile.flipped) {
                // For documentation:
                // // - flips the tile so that we see it's back
                // const flipLeftAroundTileOrigin = $.Mat3.makeScaling(-1, 1);
                // //  tile's geometry stays the same so when looking at it's back we gotta reverse the logic we would normally use
                // const moveRightAfterScaling = $.Mat3.makeTranslation(-1, 0);
                // matrix = matrix.multiply(flipLeftAroundTileOrigin).multiply(moveRightAfterScaling);

                //Optimized:
                model.scaleAndTranslateSelf(-1, 1, 1, 0);
            }

            model.scaleAndTranslateOtherSetSelf(viewMatrix);
            return model.values;
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

        /**
         * Extract texture data into the canvas in this.offScreenTexturesAsCanvases[index] for debugging purposes.
         * @returns
         */
        // Generated with ChatGPT, customized.
        _extractOffScreenTexture(fpOutput, length) {
            let dx = 0;
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

            for (let index = 0; index < length * 2; index++) {

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
                contextIntermediate.putImageData(imageData, 0, 0);

                if (index % 2 === 1) {
                    ctx.drawImage(this._debugIntermediate, dx + 25, dx + 25);
                } else {
                    ctx.drawImage(this._debugIntermediate, dx, dx);
                }
                dx += 7;

            }
            // unbind and delete the framebuffer
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        }

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
            // todo better handling, build-in ID does not comply to syntax... :/
            this._id = this.constructor.idGenerator;
            // Todo: do we need to have c2d drawing output?
            // let canvas = $.makeNeutralElement("canvas");


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

            this.renderer.setDataBlendingEnabled(true); // enable alpha blending
            this.webGLVersion = this.renderer.webglVersion;
            this.debug = rendererOptions.debug;

            const canvas = this.renderer.canvas;
            let viewportSize = this._calculateCanvasSize();

            // SETUP CANVASES
            this._size = new $.Point(viewportSize.x, viewportSize.y); // current viewport size, changed during resize event
            this._gl = this.renderer.gl;
            this._setupCanvases();

            // Todo not supported:
            //this.context = this._outputContext; // API required by tests

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

            // Todo what if not supported for createImageBitmap?

            let data = cache.data;

            if (data instanceof CanvasRenderingContext2D) {
                data = data.canvas;
            }

            return createImageBitmap(data).then(data => {
                // if (!tiledImage.isTainted()) {
                // todo tained data handle
                // if((data instanceof CanvasRenderingContext2D) && $.isCanvasTainted(data.canvas)){
                //     tiledImage.setTainted(true);
                //     $.console.warn('WebGL cannot be used to draw this TiledImage because it has tainted data. Does crossOriginPolicy need to be set?');
                //     this._raiseDrawerErrorEvent(tiledImage, 'Tainted data cannot be used by the WebGLDrawer. Falling back to CanvasDrawer for this TiledImage.');
                //     this.setInternalCacheNeedsRefresh();
                // } else {
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
                    let tileMeta = this._getTileRenderMeta(tile, tiledImage);

                    let left = (tile.x === 0 ? 0 : tileMeta.overlapX) * sourceWidthFraction;
                    let top = (tile.y === 0 ? 0 : tileMeta.overlapY) * sourceHeightFraction;
                    let right = (tile.isRightMost ? 1 : 1 - tileMeta.overlapX) * sourceWidthFraction;
                    let bottom = (tile.isBottomMost ? 1 : 1 - tileMeta.overlapY) * sourceHeightFraction;
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

                const tileInfo = {
                    position: position,
                    texture: null,
                };

                if (this.debug) {
                    tileInfo.debugTiledImage = tiledImage;
                    tileInfo.debugCanvas = data; //fixme possibly an image
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
                // }
                // }

                // TODO fix this
                // if (data instanceof Image) {
                //     const canvas = document.createElement( 'canvas' );
                //     canvas.width = data.width;
                //     canvas.height = data.height;
                //     const context = canvas.getContext('2d', { willReadFrequently: true });
                //     context.drawImage( data, 0, 0 );
                //     data = context;
                // }
                // if (data instanceof CanvasRenderingContext2D) {
                //     return data;
                // }
                $.console.error("Unsupported data used for WebGL Drawer - probably a bug!");
                return {};
            }).catch(e => {
                //TODO: support tile failure - if cache load fails in some way, the tile should be marked as such, and it should be allowed to enter rendering routine nevertheless
                $.console.error(`Unsupported data type! ${data}`, e);
            });
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
         * Draw data from the rendering canvas onto the output canvas
         * cropping and/or debug info as requested.
         * @private
         * @param {OpenSeadragon.TiledImage} tiledImage - the tiledImage to draw
         * @param {Array} tilesToDraw - array of objects containing tiles that were drawn
         */
        _applyContext2dPipeline(tiledImage, tilesToDraw, tiledImageIndex) {
            this._outputContext.save();

            // set composite operation; ignore for first image drawn
            this._outputContext.globalCompositeOperation = tiledImageIndex === 0 ? null : tiledImage.compositeOperation || this.viewer.compositeOperation;
            this._outputContext.drawImage(this._renderingCanvas, 0, 0);
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
            // no-op: called, handled during rendering from tiledImage data
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

    OpenSeadragon.WebGLDrawerModular._idGenerator = 0;
    Object.defineProperty(OpenSeadragon.WebGLDrawerModular, 'idGenerator', {
        get: function() {
            return this._idGenerator++;
        }
    });
}( OpenSeadragon ));
