(function($) {
    /**
     * @property {RegExp} idPattern
     * @property {Object} BLEND_MODE
     * @property {Number} BLEND_MODE_MULTIPLY
     *
     * @class OpenSeadragon.WebGLModule
     * @classdesc class that manages ShaderLayers, their controls, and WebGLContext to allow rendering using WebGL
     * @memberof OpenSeadragon
     */
    $.WebGLModule = class extends $.EventSource {
        /**
         * @typedef ControlsHTMLElementsGenerator
         * @type function
         * @param {String} html
         * @param {String} id
         * @param {Boolean} isVisible
         * @param {Object} shaderConfig
         * @param {Boolean} isControllable
         * @param {OpenSeadragon.WebGLModule.ShaderLayer} shaderLayer
         * @returns {String}
         */

        /**
         * @param {Object} incomingOptions
         *
         * @param {String} incomingOptions.uniqueId
         *
         * @param {String} incomingOptions.webGLPreferredVersion    prefered WebGL version, "1.0" or "2.0"
         *
         * @param {String} incomingOptions.htmlControlsId                               id of the DOM element where the ShaderLayers' controls' HTML elements will be put
         * @param {ControlsHTMLElementsGenerator} incomingOptions.htmlShaderPartHeader  function that generates individual ShaderLayer's controls' HTML code
         *
         * @param {Function} incomingOptions.ready                  function called when WebGLModule is ready to render
         * @param {Function} incomingOptions.resetCallback          function called when user input changed; triggers re-render of the viewport
         * @param {Function} incomingOptions.refetchCallback        function called when underlying data changed; triggers re-initialization of the whole WebGLDrawer
         * @param {Boolean} incomingOptions.debug                   debug mode on/off
         *
         * @param {Object} incomingOptions.canvasOptions
         * @param {Boolean} incomingOptions.canvasOptions.alpha
         * @param {Boolean} incomingOptions.canvasOptions.premultipliedAlpha
         * @param {Boolean} incomingOptions.canvasOptions.stencil
         *
         * @constructor
         * @memberof WebGLModule
         */
        constructor(incomingOptions) {
            super();

            if (!this.constructor.idPattern.test(incomingOptions.uniqueId)) {
                throw new Error("$.WebGLModule::constructor: invalid ID! Id can contain only letters, numbers and underscore. ID: " + incomingOptions.uniqueId);
            }
            this.uniqueId = incomingOptions.uniqueId;

            this.webGLPreferredVersion = incomingOptions.webGLPreferredVersion;


            this.htmlControlsId = incomingOptions.htmlControlsId;
            this.htmlShaderPartHeader = incomingOptions.htmlShaderPartHeader;
            if (this.supportsHtmlControls()) {
                this.htmlControlsElement = document.getElementById(this.htmlControlsId);
                if (!this.htmlControlsElement) {
                    console.warn('$.WebGLModule::constructor: WebGLModule should support HTML controls, but could not find DOM element with id =', this.htmlControlsId);
                    this.htmlControlsId = null;
                    this.htmlShaderPartHeader = null;
                }
            }

            this.ready = incomingOptions.ready;
            this.resetCallback = incomingOptions.resetCallback;
            this.refetchCallback = incomingOptions.refetchCallback;
            this.debug = incomingOptions.debug;

            this.canvasContextOptions = incomingOptions.canvasOptions;
            const canvas = document.createElement("canvas");
            const WebGLImplementation = this.constructor.determineContext(this.webGLPreferredVersion);
            const webGLRenderingContext = $.WebGLModule.WebGLImplementation.create(canvas, this.webGLPreferredVersion, this.canvasContextOptions);
            if (webGLRenderingContext) {
                this.gl = webGLRenderingContext;                                            // WebGLRenderingContext|WebGL2RenderingContext
                this.webglContext = new WebGLImplementation(this, webGLRenderingContext);   // $.WebGLModule.WebGLImplementation
                this.canvas = canvas;
            } else {
                throw new Error("$.WebGLModule::constructor: Could not create WebGLRenderingContext!");
            }

            this.running = false;           // boolean; true if WebGLModule is ready to render
            this._program = -1;             // WebGLProgram
            this.firstPassShader = null;    // custom identity ShaderLayer used for the first-pass during two-pass rendering
            this._shaders = {};             // {shaderID1: ShaderLayer1, shaderID2: ShaderLayer2, ...}
        }

        /**
         * Search through all WebGLModule properties to find one that extends WebGLImplementation and it's getVersion() method returns <version> input parameter.
         * @param {String} version WebGL version, "1.0" or "2.0"
         * @returns {WebGLImplementation}
         *
         * @instance
         * @memberof WebGLModule
         */
        static determineContext(version) {
            const namespace = $.WebGLModule;
            for (let property in namespace) {
                const context = namespace[ property ],
                    proto = context.prototype;
                if (proto && proto instanceof namespace.WebGLImplementation &&
                    $.isFunction( proto.getVersion ) && proto.getVersion.call( context ) === version) {
                        return context;
                }
            }

            throw new Error("$.WebGLModule::determineContext: Could not find WebGLImplementation with version " + version);
        }

        /**
         * Set viewport dimensions.
         * @param {Number} x
         * @param {Number} y
         * @param {Number} width
         * @param {Number} height
         *
         * @instance
         * @memberof WebGLModule
         */
        setDimensions(x, y, width, height) {
            this.canvas.width = width;
            this.canvas.height = height;
            this.gl.viewport(x, y, width, height);
        }

        /**
         * Call to draw using WebGLProgram.
         * @param {Object} renderInfo
         * @param {Float32Array} renderInfo.transform       position transform matrix
         * @param {Number} renderInfo.zoom                  value passed to the shaders as u_zoom_level
         * @param {Number} renderInfo.pixelSize             value passed to the shaders as u_pixel_size_in_fragments
         * @param {Number} renderInfo.globalOpacity         value passed to the shaders as u_global_alpha
         * @param {Float32Array} renderInfo.textureCoords   coordinates for texture sampling
         *
         * @param {ShaderLayer} shaderLayer                 instantion of shaderLayer to use for rendering logic
         *
         * @param {Object} source
         * @param {[WebGLTexture]} source.textures          [TEXTURE_2D]
         * @param {WebGLTexture} source.texture2DArray      TEXTURE_2D_ARRAY
         * @param {Number} source.index                     index of texture in textures array or index of layer in texture2DArray
         *
         * @instance
         * @memberof WebGLModule
         */
        processData(renderInfo, shaderLayer, source) {
            if (this.webGLPreferredVersion === "2.0") {
                this.webglContext.useProgram(this._program, renderInfo, shaderLayer, source.texture2DArray, source.index);
            } else {
                this.webglContext.useProgram(this._program, renderInfo, shaderLayer, source.textures[source.index]);
            }
        }

        /**
         * Call to first-pass draw using WebGLProgram.
         * @param {Float32Array} textureCoords
         * @param {Float32Array} transformMatrix

         * @param {Object} source
         * @param {[WebGLTexture]} source.textures          [TEXTURE_2D]
         * @param {WebGLTexture} source.texture2DArray      TEXTURE_2D_ARRAY
         * @param {Number} source.index                     index of texture in textures array or index of layer in texture2DArray
         *
         * @instance
         * @memberof WebGLModule
         */
        firstPassProcessData(textureCoords, transformMatrix, source) {
            if (this.webGLPreferredVersion === "2.0") {
                this.webglContext.useProgramForFirstPass(transformMatrix, textureCoords, source.texture2DArray, source.index);
            } else {
                this.webglContext.useProgramForFirstPass(transformMatrix, textureCoords, source.textures[source.index]);
            }
        }

        /**
         * Whether the WebGLModule creates HTML elements in the DOM for ShaderLayers' controls.
         * @return {Boolean}
         *
         * @instance
         * @memberof WebGLModule
         */
        supportsHtmlControls() {
            return typeof this.htmlControlsId === "string" && this.htmlControlsId.length > 0;
        }

        /**
         * Initialize the WebGLModule.
         * Create the custom identity first-pass ShaderLayer that will be used for first-pass during two-pass rendering.
         * Create the WebGLProgram.
         *
         * @instance
         * @memberof WebGLModule
         */
        init() {
            const Shader = $.WebGLModule.ShaderMediator.getClass("firstPass");
            if (!Shader) {
                throw new Error("$.WebGLModule::init: Could not find the first-pass ShaderLayer!");
            }

            const shader = new Shader("first_pass_identity", {
                shaderConfig: {},
                webglContext: this.webglContext,
                controls: {},
                interactive: false,
                cache: {},
                invalidate: () => {},
                rebuild: () => {},
                refetch: () => {}
            });
            shader.__channels = {};
            shader.__channels[0] = "rgba";

            this.firstPassShader = shader;
            this.createProgram();
        }

        /**
         * Create and load the new WebGLProgram based on ShaderLayers and their controls.
         *
         * @instance
         * @memberof WebGLModule
         */
        createProgram() {
            // create new WebGLProgram based on ShaderLayers at disposal
            const program = this.webglContext.createProgram(this._shaders);
            this._program = program;
            this.gl.useProgram(program);

            // generate HTML elements for ShaderLayer's controls and put them into the DOM
            if (this.supportsHtmlControls()) {
                let html = '';
                for (const shaderLayer of Object.values(this._shaders)) {
                    const shaderConfig = shaderLayer.__shaderConfig;
                    const visible = shaderConfig.visible;
                    html += this.htmlShaderPartHeader(
                        shaderLayer.htmlControls(),
                        shaderLayer.id,
                        visible,
                        shaderConfig,
                        true,
                        shaderLayer
                    );
                }

                this.htmlControlsElement.innerHTML = html;
            }

            // initialize ShaderLayer's controls:
            //      - set their values to default,
            //      - if interactive register event handlers to their corresponding DOM elements created in the previous step
            for (const shaderLayer of Object.values(this._shaders)) {
                shaderLayer.init();
            }

            // load the uniforms and attributes of the program, and also uniforms of the ShaderLayers and their controls
            this.webglContext.loadProgram(program, this._shaders);

            if (!this.running) {
                //TODO: might not be the best place to call, timeout necessary to allow finish initialization of OSD before called
                setTimeout(() => this.ready());
            }
            this.running = true;
        }

        /**
         * Create and initialize new ShaderLayer instantion and its controls.
         * @param {Object} shaderConfig object bind to a concrete ShaderLayer instantion
         * @param {String} shaderConfig.id     unique identifier
         * @param {String} shaderConfig.externalId   unique identifier, used to communicate with the xOpat's API
         * @param {String} shaderConfig.name
         * @param {String} shaderConfig.type         equal to ShaderLayer.type(), e.g. "identity"
         * @param {Number} shaderConfig.visible      1 = use for rendering, 0 = do not use for rendering
         * @param {Boolean} shaderConfig.fixed
         * @param {Object} shaderConfig.params       settings for the ShaderLayer
         * @param {Object} shaderConfig._controls    storage for the ShaderLayer's controls
         * @param {Object} shaderConfig._cache       cache object used by the ShaderLayer's controls
         * @returns {ShaderLayer}       instantion of the created shaderLayer
         *
         * @instance
         * @memberof WebGLModule
         */
        createShaderLayer(shaderConfig) {
            const shaderID = shaderConfig.id;
            const shaderType = shaderConfig.type;

            const Shader = $.WebGLModule.ShaderMediator.getClass(shaderType);
            if (!Shader) {
                throw new Error(`$.WebGLModule::createShaderLayer: Unknown shader type '${shaderType}'!`);
            }

            const shader = new Shader(shaderID, {
                shaderConfig: shaderConfig,
                webglContext: this.webglContext,
                controls: shaderConfig._controls,
                interactive: this.supportsHtmlControls(),
                cache: shaderConfig._cache,
                params: shaderConfig.params,

                // callback to re-render the viewport
                invalidate: this.resetCallback,
                // callback to rebuild the WebGL program
                rebuild: () => {
                    this.createProgram();
                },
                // callback to reinitialize the drawer; NOT USED
                refetch: this.refetchCallback
            });
            shader.construct();

            this._shaders[shaderID] = shader;
            this.createProgram();

            return shader;
        }

        /**
         * Remove ShaderLayer instantion and its controls.
         * @param {object} shaderConfig object bind to a concrete ShaderLayer instantion
         *
         * @instance
         * @memberof WebGLModule
         */
        removeShader(shaderConfig) {
            const shaderID = shaderConfig.id;
            const shader = this._shaders[shaderID];
            // FIXME TRIM shader.removeControls();

            delete this._shaders[shaderID];
            this.createProgram();
        }

        /**
         * @param {Boolean} enabled if true enable alpha blending, otherwise disable blending
         *
         * @instance
         * @memberof WebGLModule
         */
        setDataBlendingEnabled(enabled) {
            if (enabled) {
                this.gl.enable(this.gl.BLEND);

                // standard alpha blending
                this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);
            } else {
                this.gl.disable(this.gl.BLEND);
            }
        }
    };


    // STATIC PROPERTIES
    /**
     * ID pattern allowed for WebGLModule. ID's are used in GLSL to distinguish uniquely between individual ShaderLayer's generated code parts
     * @property
     * @type {RegExp}
     * @memberof WebGLModule
     */
    $.WebGLModule.idPattern = /^(?!_)(?:(?!__)[0-9a-zA-Z_])*$/;

    $.WebGLModule.BLEND_MODE = {
        'source-over': 0,
        'source-in': 1,
        'source-out': 1,
        'source-atop': 1,
        'destination-over': 1,
        'destination-in': 1,
        'destination-out': 1,
        'destination-atop': 1,
        lighten: 1,
        darken: 1,
        copy: 1,
        xor: 1,
        multiply: 1,
        screen: 1,
        overlay: 1,
        'color-dodge': 1,
        'color-burn': 1,
        'hard-light': 1,
        'soft-light': 1,
        difference: 1,
        exclusion: 1,
        hue: 1,
        saturation: 1,
        color: 1,
        luminosity: 1
    };

    $.WebGLModule.BLEND_MODE_MULTIPLY = 1;
})(OpenSeadragon);
