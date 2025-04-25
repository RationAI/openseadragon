(function($) {
    $.WebGLModule.WebGL20 = class extends $.WebGLModule.WebGLImplementation {
    /**
     * Create a WebGL 2.0 rendering implementation.
     * @param {OpenSeadragon.WebGLModule} renderer
     * @param {WebGL2RenderingContext} gl
     */
    constructor(renderer, gl) {
        // sets this.renderer, this.gl, this.webGLVersion
        super(renderer, gl, "2.0");
        $.console.info("WebGl 2.0 renderer.");
    }

    get firstPassProgramKey() {
        return "firstPass";
    }

    get secondPassProgramKey() {
        return "secondPass";
    }

    init() {
        //todo consider passing reference to this
        this.renderer.registerProgram(new $.WebGLModule.WebGL20.FirstPassProgram(this, this.gl), "firstPass");
        this.renderer.registerProgram(new $.WebGLModule.WebGL20.SecondPassProgram(this, this.gl), "secondPass");
    }

    getVersion() {
        return "2.0";
    }

    /**
     * Expose GLSL code for texture sampling.
     * @returns {string} glsl code for texture sampling
     */
    sampleTexture(index, vec2coords) {
        return `osd_texture(${index}, ${vec2coords})`;
    }

    getTextureSize(index) {
        return `osd_texture_size(${index})`;
    }

    setDimensions(x, y, width, height, levels) {
        this.renderer.getProgram(this.firstPassProgramKey).setDimensions(x, y, width, height, levels);
        this.renderer.getProgram(this.secondPassProgramKey).setDimensions(x, y, width, height, levels);
        //todo consider some elimination of too many calls
    }

    getBlendingFunction(name) {
        return {
            mask: `
if (close(fg.a, 0.0))  return vec4(.0);
return bg;`,
            'source-over': `
if (!stencilPasses) return bg;
vec4 pre_fg = vec4(fg.rgb * fg.a, fg.a);
return pre_fg + bg * (1.0 - pre_fg.a);`,

            'source-in': `
if (!stencilPasses) return bg;
return vec4(fg.rgb * bg.a, fg.a * bg.a);`,

            'source-out': `
if (!stencilPasses) return bg;
return vec4(fg.rgb * (1.0 - bg.a), fg.a * (1.0 - bg.a));`,

            'source-atop': `
if (!stencilPasses) return bg;
vec3 rgb = fg.rgb * bg.a + bg.rgb * (1.0 - fg.a);
float a = fg.a * bg.a + bg.a * (1.0 - fg.a);
return vec4(rgb, a);`,

            'destination-over': `
if (!stencilPasses) return bg;
vec4 pre_bg = vec4(bg.rgb * bg.a, bg.a);
return pre_bg + fg * (1.0 - pre_bg.a);`,

            'destination-in': `
if (!stencilPasses) return bg;
return vec4(bg.rgb * fg.a, fg.a * bg.a);`,

            'destination-out': `
if (!stencilPasses) return bg;
return vec4(bg.rgb * (1.0 - fg.a), bg.a * (1.0 - fg.a));`,

            'destination-atop': `
if (!stencilPasses) return bg;
vec3 rgb = bg.rgb * fg.a + fg.rgb * (1.0 - bg.a);
float a = bg.a * fg.a + fg.a * (1.0 - bg.a);
return vec4(rgb, a);`,

            lighten: `
if (!stencilPasses) return bg;
return blendAlpha(fg, bg, max(fg.rgb, bg.rgb));`,

            darken: `
if (!stencilPasses) return bg;
return blendAlpha(fg, bg, min(fg.rgb, bg.rgb));`,

            copy: `
if (!stencilPasses) return bg;
return fg;`,

            xor: `
if (!stencilPasses) return bg;
vec3 rgb = fg.rgb * (1.0 - bg.a) + bg.rgb * (1.0 - fg.a);
float a = fg.a + bg.a - 2.0 * fg.a * bg.a;
return vec4(rgb, a);`,

            multiply: `
if (!stencilPasses) return bg;
return blendAlpha(fg, bg, fg.rgb * bg.rgb);`,

            screen: `
if (!stencilPasses) return bg;
return blendAlpha(fg, bg, 1.0 - (1.0 - fg.rgb) * (1.0 - bg.rgb));`,

            overlay: `
if (!stencilPasses) return bg;
vec3 rgb = mix(2.0 * fg.rgb * bg.rgb, 1.0 - 2.0 * (1.0 - fg.rgb) * (1.0 - bg.rgb), step(0.5, bg.rgb));
return blendAlpha(fg, bg, rgb);`,

            'color-dodge': `
if (!stencilPasses) return bg;
vec3 rgb = bg.rgb / (1.0 - fg.rgb + 1e-5);
return blendAlpha(fg, bg, min(rgb, 1.0));`,

            'color-burn': `
if (!stencilPasses) return bg;
vec3 rgb = 1.0 - ((1.0 - bg.rgb) / (fg.rgb + 1e-5));
return blendAlpha(fg, bg, clamp(rgb, 0.0, 1.0));`,

            'hard-light': `
if (!stencilPasses) return bg;
vec3 rgb = mix(2.0 * fg.rgb * bg.rgb, 1.0 - 2.0 * (1.0 - fg.rgb) * (1.0 - bg.rgb), step(0.5, fg.rgb));
return blendAlpha(fg, bg, rgb);`,

            'soft-light': `
if (!stencilPasses) return bg;
vec3 rgb = (bg.rgb < 0.5)
    ? (2.0 * fg.rgb * bg.rgb + fg.rgb * fg.rgb * (1.0 - 2.0 * bg.rgb))
    : (sqrt(fg.rgb) * (2.0 * bg.rgb - 1.0) + 2.0 * fg.rgb * (1.0 - bg.rgb));
return blendAlpha(fg, bg, clamp(rgb, 0.0, 1.0));`,

            difference: `
if (!stencilPasses) return bg;
return blendAlpha(fg, bg, abs(bg.rgb - fg.rgb));`,

            exclusion: `
if (!stencilPasses) return bg;
return blendAlpha(fg, bg, bg.rgb + fg.rgb - 2.0 * bg.rgb * fg.rgb);`,
        }[name];
    }
};


$.WebGLModule.WebGL20.SecondPassProgram = class extends $.WebGLModule.Program {
    constructor(context, gl) {
        super(context, gl);
        this._maxTextures = Math.min(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS), 32);
        //todo this might be limiting in some wild cases... make it configurable..? or consider 1d texture
        this.textureMappingsUniformSize = 64;
    }

    get webGLProgram() {
        if (!this._webGLProgram) {
            throw Error("Program accessed without registration - did you call this.renderer.registerProgram()?");
        }
        return this._webGLProgram;
    }

    build(shaderMap, keyOrder) {
        if (!keyOrder.length) {
            // Todo prevent unimportant first init build call
            this.vertexShader = this._getVertexShaderSource();
            this.fragmentShader = this._getFragmentShaderSource('', '',
                '', $.WebGLModule.ShaderLayer.__globalIncludes);
            return;
        }
        let definition = '',
            execution = `
vec4 intermediate_color = vec4(.0);
vec4 clip_color = vec4(.0);
`,
            customBlendFunctions = '';

        const addShaderDefinition = shader => {
            definition += `
// ${shader.constructor.type()} - Definition
${shader.getFragmentShaderDefinition()}
// ${shader.constructor.type()} - Custom blending function for a given shader
${shader.getCustomBlendFunction(shader.uid + "_blend_func")}
// ${shader.constructor.type()} - Shader code execution
vec4 ${shader.uid}_execution() {
${shader.getFragmentShaderExecution()}
}
`;
        };

        let remainingBlenForShaderID = '';
        const getRemainingBlending = () => { //todo next blend argument
            if (remainingBlenForShaderID) {
                const i = keyOrder.indexOf(remainingBlenForShaderID);
                const shader = shaderMap[remainingBlenForShaderID];
                // Set stencilPasses again: we are going to blend deferred data
                return `
    stencilPasses = texture(u_stencilTextures, vec3(v_texture_coords, float(${i}))).r > 0.95;
    overall_color = ${shader.mode === "show" ? "blend_source_over" : shader.uid + "_blend_func"}(intermediate_color, overall_color);
`;
            }
            return '';
        };

        let i = 0;
        for (; i < keyOrder.length; i++) {
            const previousShaderID = keyOrder[i];
            const previousShaderLayer = shaderMap[previousShaderID];
            const shaderConf = previousShaderLayer.getConfig();

            if (shaderConf.type === "none" || shaderConf.error || !shaderConf.visible) {
                //prevents the layer from being accounted for in the rendering (error or not visible)

                // For explanation of this logics see main shader part below
                if (previousShaderLayer._mode !== "mask_clip") {
                    execution += `${getRemainingBlending()}
// ${previousShaderLayer.constructor.type()} - Disabled (error or visible = false)
intermediate_color = vec4(.0);`;
                    remainingBlenForShaderID = previousShaderID;
                } else {
                    execution += `
// ${previousShaderLayer.constructor.type()} - Disabled with Clipmask (error or visible = false)
intermediate_color = ${previousShaderLayer.uid}_blend_func(vec4(.0), intermediate_color);`;
                }
                continue;
            }

            addShaderDefinition(previousShaderLayer);
            execution += `
    stencilPasses = texture(u_stencilTextures, vec3(v_texture_coords, float(${i}))).r > 0.95;
    instance_id = ${i};
    vec3 attrs_${i} = u_shaderVariables[${i}];
    opacity = attrs_${i}.x;
    pixelSize = attrs_${i}.y;
    zoom = attrs_${i}.z;`;

            // To understand the code below: show & mask are basically same modes: they blend atop
            // of existing data. 'Show' just uses built-in alpha blending.
            // However, mask_clip blends on the previous output only (and it can chain!).

            if (previousShaderLayer._mode !== "mask_clip") {
                    execution += `${getRemainingBlending()}
// ${previousShaderLayer.constructor.type()} - Blending
intermediate_color = ${previousShaderLayer.uid}_execution();
intermediate_color.a = intermediate_color.a * opacity;`;
                remainingBlenForShaderID = previousShaderID;
            } else {
                execution += `
// ${previousShaderLayer.constructor.type()} - Clipmask
clip_color = ${previousShaderLayer.uid}_execution();
clip_color.a = clip_color.a * opacity;
intermediate_color = ${previousShaderLayer.uid}_blend_func(clip_color, intermediate_color);`;
            }
        } // end of for cycle

        if (remainingBlenForShaderID) {
            execution += getRemainingBlending();
        }
        this.vertexShader = this._getVertexShaderSource();
        this.fragmentShader = this._getFragmentShaderSource(definition, execution,
            customBlendFunctions, $.WebGLModule.ShaderLayer.__globalIncludes);
    }

    /**
     * Create program.
     * @param width
     * @param height
     */
    created(width, height) {
        const gl = this.gl;
        const program = this.webGLProgram;

        // Shader element indexes match element id (instance id) to position in the texture array
        this._instanceOffsets = gl.getUniformLocation(program, "u_instanceOffsets");
        this._instanceTextureIndexes = gl.getUniformLocation(program, "u_instanceTextureIndexes");
        this._shaderVariables = gl.getUniformLocation(program, "u_shaderVariables");

        this._texturesLocation = gl.getUniformLocation(program, "u_inputTextures");
        this._stencilLocation = gl.getUniformLocation(program, "u_stencilTextures");

        this.vao = gl.createVertexArray();
    }

    /**
     * Load program. No arguments.
     */
    load(renderArray) {
        const gl = this.gl;
        // ShaderLayers' controls
        for (const renderInfo of renderArray) {
            renderInfo.shader.glDrawing(this.webGLProgram, gl);
        }
    }

    /**
     * Use program. Arbitrary arguments.
     */
    use(source, renderArray) {
        //todo flatten render array :/
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindVertexArray(this.vao);

        const shaderVariables = [];
        const instanceOffsets = [];
        const instanceTextureIndexes = [];
        for (const renderInfo of renderArray) {
            renderInfo.shader.glDrawing(this.webGLProgram, gl);

            shaderVariables.push(renderInfo.opacity, renderInfo.pixelSize, renderInfo.zoom);

            instanceOffsets.push(instanceTextureIndexes.length);
            instanceTextureIndexes.push(...renderInfo.shader.getConfig().tiledImages);
        }

        gl.uniform1iv(this._instanceOffsets, instanceOffsets);
        gl.uniform1iv(this._instanceTextureIndexes, instanceTextureIndexes);
        gl.uniform3fv(this._shaderVariables, shaderVariables);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, source.texture);
        gl.uniform1i(this._texturesLocation, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, source.stencil);
        gl.uniform1i(this._stencilLocation, 1);


        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
    }

    /**
     * Destroy program. No arguments.
     */
    destroy() {
        this.gl.deleteVertexArray(this.vao);
    }

    // TODO we might want to fire only for active program and do others when really encesarry or with some delay, best at some common implementation level
    setDimensions(x, y, width, height, levels) {
    }

    // PRIVATE FUNCTIONS
    /**
     * Get vertex shader's glsl code.
     * @returns {string} vertex shader's glsl code
     */
    _getVertexShaderSource() {
        const vertexShaderSource = `#version 300 es
precision mediump int;
precision mediump float;

out vec2 v_texture_coords;

const vec3 viewport[4] = vec3[4] (
    vec3(-1.0, 1.0, 1.0),
    vec3(-1.0, -1.0, 1.0),
    vec3(1.0, 1.0, 1.0),
    vec3(1.0, -1.0, 1.0)
);

void main() {
    v_texture_coords = vec2(viewport[gl_VertexID]) / 2.0 + 0.5;
    gl_Position = vec4(viewport[gl_VertexID], 1.0);
}
`;

        return vertexShaderSource;
    }

    /**
     * Get fragment shader's glsl code.
     * @param {string} definition ShaderLayers' glsl code placed outside the main function
     * @param {string} execution ShaderLayers' glsl code placed inside the main function
     * @param {string} globalScopeCode ShaderLayers' glsl code shared between the their instantions
     * @returns {string} fragment shader's glsl code
     */
    _getFragmentShaderSource(definition, execution, globalScopeCode) {
        const fragmentShaderSource = `#version 300 es
precision mediump int;
precision mediump float;
precision mediump sampler2DArray;

uniform int u_instanceTextureIndexes[${this.textureMappingsUniformSize}];
uniform int u_instanceOffsets[${this.textureMappingsUniformSize}];
uniform vec3 u_shaderVariables[${this.textureMappingsUniformSize}];

in vec2 v_texture_coords;

bool stencilPasses;
int instance_id;
float opacity;
float pixelSize;
float zoom;

uniform sampler2DArray u_inputTextures;
uniform sampler2DArray u_stencilTextures;

vec4 osd_texture(int index, vec2 coords) {
    int offset = u_instanceOffsets[instance_id];
    index = u_instanceTextureIndexes[offset + index];
    return texture(u_inputTextures, vec3(coords, float(index)));
}

ivec2 osd_texture_size(int index) {
    int offset = u_instanceOffsets[instance_id];
    index = u_instanceTextureIndexes[offset + index];
    return textureSize(u_inputTextures, index).xy;
}

// UTILITY function
bool close(float value, float target) {
    return abs(target - value) < 0.001;
}

// BLEND attributes
out vec4 overall_color;
vec4 blendAlpha(vec4 fg, vec4 bg, vec3 rgb) {
    float a = fg.a + bg.a * (1.0 - fg.a);
    return vec4(rgb, a);
}
vec4 blend_source_over(vec4 fg, vec4 bg) {
    if (!stencilPasses) return bg;
    vec4 pre_fg = vec4(fg.rgb * fg.a, fg.a);
    return pre_fg + bg * (1.0 - pre_fg.a);
}

// GLOBAL SCOPE CODE:${Object.keys(globalScopeCode).length !== 0 ? Object.values(globalScopeCode).join("\n") : '\n    // No global scope code here...'}

// DEFINITIONS OF SHADERLAYERS:${definition !== '' ? definition : '\n    // Any non-default shaderLayer here to define...'}

void main() {
    ${execution}
}`;

        return fragmentShaderSource;
    }
};

$.WebGLModule.WebGL20.FirstPassProgram = class extends $.WebGLModule.Program {

    constructor(context, gl) {
        super(context, gl);
        this._maxTextures = Math.min(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS), 32);
        this._textureIndexes = [...Array(this._maxTextures).keys()];
        // Todo: RN we support only MAX_COLOR_ATTACHMENTS in the texture array, which varies beetween devices
        //   make the first pass shader run multiple times if the number does not suffice
        this._maxAttachments = gl.getParameter(gl.MAX_COLOR_ATTACHMENTS);
    }

    build(shaderMap, shaderKeys) {
        this.vertexShader = `#version 300 es
precision mediump int;
precision mediump float;

layout(location = 0) in mat3 a_transform_matrix;
layout(location = 4) in vec2 a_texture_coords;

uniform vec2 u_renderClippingParams;

out vec2 v_texture_coords;
flat out int instance_id;

const vec3 viewport[4] = vec3[4] (
    vec3(0.0, 1.0, 1.0),
    vec3(0.0, 0.0, 1.0),
    vec3(1.0, 1.0, 1.0),
    vec3(1.0, 0.0, 1.0)
);

in vec2 a_positions;

void main() {
    v_texture_coords = a_texture_coords;

    vec3 space_2d = u_renderClippingParams.x > 0.5 ?
        a_transform_matrix * vec3(a_positions, 1.0) :
        a_transform_matrix * viewport[gl_VertexID];

    gl_Position = vec4(space_2d.xy, 1.0, space_2d.z);
    instance_id = gl_InstanceID;
}
`;
        this.fragmentShader = `#version 300 es
precision mediump int;
precision mediump float;
precision mediump sampler2D;

uniform vec2 u_renderClippingParams;

flat in int instance_id;
in vec2 v_texture_coords;
uniform sampler2D u_textures[${this._maxTextures}];

layout(location=0) out vec4 outputColor;
layout(location=1) out float outputStencil;

void main() {
    if (u_renderClippingParams.x < 0.5) {
        // Iterate over tiles - textures for each tile (a texture array)
        for (int i = 0; i < ${this._maxTextures}; i++) {
            // Iterate over data in each tile if the index matches our tile
            if (i == instance_id) {
                 switch (i) {
    ${this.printN(x => `case ${x}: outputColor = texture(u_textures[${x}], v_texture_coords); break;`,
                this._maxTextures, "                ")}
                 }
                 break;
            }
        }
        outputStencil = 1.0;
    }
}
`;
    }

    created(width, height) {
        const gl = this.gl;
        const program = this.webGLProgram;

        // Texture creation happens on setDimensions, called later

        let vao = this.firstPassVao;
        if (!vao) {
            this.offScreenBuffer = gl.createFramebuffer();

            this.firstPassVao = vao = gl.createVertexArray();
            this.matrixBuffer = gl.createBuffer();
            this.texCoordsBuffer = gl.createBuffer();

            this.matrixBufferClip = gl.createBuffer();
            this.firstPassVaoClip = gl.createVertexArray();
            this.positionsBufferClip = gl.createBuffer();
        }

        // Texture locations are 0->N uniform indexes, we do not load the data here yet as vao does not store them
        this._inputTexturesLoc = gl.getUniformLocation(program, "u_textures");
        this._renderClipping = gl.getUniformLocation(program, "u_renderClippingParams");

        // Setup all rendering props once beforehand
        gl.bindVertexArray(vao);
        // Texture coords are vec2 * 4 coords for the textures, needs to be passed since textures can have offset
        this._texCoordsBuffer = gl.getAttribLocation(program, "a_texture_coords");
        gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordsBuffer);
        gl.enableVertexAttribArray(this._texCoordsBuffer);
        gl.vertexAttribPointer(this._texCoordsBuffer, 2, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(this._texCoordsBuffer, 0);

        // We call bufferData once, then we just call subData
        const maxTexCoordBytes = this._maxTextures * 8 * Float32Array.BYTES_PER_ELEMENT;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordsBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, maxTexCoordBytes, gl.DYNAMIC_DRAW);

        // To be able to use the clipping along with tile render, we pass points explicitly
        this._positionsBuffer = gl.getAttribLocation(program, "a_positions");

        // Matrices position tiles, 3*3 matrix per tile sent as 3 attributes in
        this._matrixBuffer = gl.getAttribLocation(program, "a_transform_matrix");
        const matLoc = this._matrixBuffer;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.matrixBuffer);
        gl.enableVertexAttribArray(matLoc);
        gl.enableVertexAttribArray(matLoc + 1);
        gl.enableVertexAttribArray(matLoc + 2);
        gl.vertexAttribPointer(matLoc, 3, gl.FLOAT, false, 9 * Float32Array.BYTES_PER_ELEMENT, 0);
        gl.vertexAttribPointer(matLoc + 1, 3, gl.FLOAT, false, 9 * Float32Array.BYTES_PER_ELEMENT, 3 * Float32Array.BYTES_PER_ELEMENT);
        gl.vertexAttribPointer(matLoc + 2, 3, gl.FLOAT, false, 9 * Float32Array.BYTES_PER_ELEMENT, 6 * Float32Array.BYTES_PER_ELEMENT);
        gl.vertexAttribDivisor(matLoc, 1);
        gl.vertexAttribDivisor(matLoc + 1, 1);
        gl.vertexAttribDivisor(matLoc + 2, 1);
        // We call bufferData once, then we just call subData
        const maxMatrixBytes = this._maxTextures * 9 * Float32Array.BYTES_PER_ELEMENT;
        gl.bufferData(gl.ARRAY_BUFFER, maxMatrixBytes, gl.STREAM_DRAW);


        // Clipping stage
        vao = this.firstPassVaoClip;
        gl.bindVertexArray(vao);
        // We don't care about texture and we re-use the positions, we discard this data
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionsBufferClip);  // we really need positionsBufferClip here!
        gl.enableVertexAttribArray(this._texCoordsBuffer);
        gl.vertexAttribPointer(this._texCoordsBuffer, 2, gl.FLOAT, false, 0, 0);
        // To be able to use the clipping along with tile render, we pass points explicitly
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionsBufferClip);
        gl.enableVertexAttribArray(this._positionsBuffer);
        gl.vertexAttribPointer(this._positionsBuffer, 2, gl.FLOAT, false, 0, 0);
        // We use static matrix
        gl.bindBuffer(gl.ARRAY_BUFFER, this.matrixBufferClip);
        gl.enableVertexAttribArray(matLoc);
        gl.enableVertexAttribArray(matLoc + 1);
        gl.enableVertexAttribArray(matLoc + 2);
        gl.vertexAttribPointer(matLoc, 3, gl.FLOAT, false, 9 * Float32Array.BYTES_PER_ELEMENT, 0);
        gl.vertexAttribPointer(matLoc + 1, 3, gl.FLOAT, false, 9 * Float32Array.BYTES_PER_ELEMENT, 3 * Float32Array.BYTES_PER_ELEMENT);
        gl.vertexAttribPointer(matLoc + 2, 3, gl.FLOAT, false, 9 * Float32Array.BYTES_PER_ELEMENT, 6 * Float32Array.BYTES_PER_ELEMENT);
        gl.vertexAttribDivisor(matLoc, 1);
        gl.vertexAttribDivisor(matLoc + 1, 1);
        gl.vertexAttribDivisor(matLoc + 2, 1);
        gl.bufferData(gl.ARRAY_BUFFER, maxMatrixBytes, gl.STREAM_DRAW);

        // Good practice
        gl.bindVertexArray(null);
    }

    /**
     * Load program. No arguments.
     */
    load() {
        this.gl.uniform1iv(this._inputTexturesLoc, this._textureIndexes);
        this.gl.disable(this.gl.BLEND);
    }

    /**
     * Use program. Arbitrary arguments.
     * @param {FPRenderPackage[]} sourceArray
     */
    use(sourceArray) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.offScreenBuffer);
        gl.enable(gl.STENCIL_TEST);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, this.stencilClipBuffer);

        // this.fpTexture = this.fpTexture === this.colorTextureA ? this.colorTextureB : this.colorTextureA;
        // this.fpTextureClip = this.fpTextureClip === this.stencilTextureA ? this.stencilTextureB : this.stencilTextureA;
        this.fpTexture = this.colorTextureA;
        this.fpTextureClip = this.stencilTextureA;

        this._renderOffset = 0;

        // Allocate reusable buffers once
        if (!this._tempMatrixData) {
            this._tempMatrixData = new Float32Array(this._maxTextures * 9);
            this._tempTexCoords = new Float32Array(this._maxTextures * 8);
        }
        let wasClipping = true; // force first init (~ as if was clipping was true)

        for (const renderInfo of sourceArray) {
            const source = renderInfo.tiles;
            const attachments = [];
            // for (let i = 0; i < 1; i++) {
                gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                    this.fpTexture, 0, this._renderOffset);
                attachments.push(gl.COLOR_ATTACHMENT0);

                gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + 1,
                    this.fpTextureClip, 0, this._renderOffset);
                attachments.push(gl.COLOR_ATTACHMENT0 + 1);
            //}
            gl.drawBuffers(attachments);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

            // First, clip polygons if any required
            if (renderInfo.stencilPolygons.length) {
                gl.stencilFunc(gl.ALWAYS, 1, 0xFF);
                gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);

                // Note: second param unused for now...
                gl.uniform2f(this._renderClipping, 1, 0);
                gl.bindVertexArray(this.firstPassVaoClip);

                gl.bindBuffer(gl.ARRAY_BUFFER, this.matrixBufferClip);
                gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(renderInfo._temp.values));

                for (const polygon of renderInfo.stencilPolygons) {
                    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionsBufferClip);
                    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(polygon), gl.STATIC_DRAW);
                    gl.drawArrays(gl.TRIANGLE_FAN, 0, polygon.length / 2);
                }

                gl.stencilFunc(gl.EQUAL, renderInfo.stencilPolygons.length, 0xFF);
                gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
                // Note: second param unused for now...
                gl.uniform2f(this._renderClipping, 0, 0);
                wasClipping = true;

            } else if (wasClipping) {
                gl.uniform2f(this._renderClipping, 0, 0);
                gl.stencilFunc(gl.EQUAL, 0, 0xFF);
                wasClipping = false;
            }

            // Then draw join tiles
            gl.bindVertexArray(this.firstPassVao);
            const tileCount = source.length;
            let currentIndex = 0;

            while (currentIndex < tileCount) {
                const batchSize = Math.min(this._maxTextures, tileCount - currentIndex);

                for (let i = 0; i < batchSize; i++) {
                    const tile = source[currentIndex + i];

                    gl.activeTexture(gl.TEXTURE0 + i);
                    gl.bindTexture(gl.TEXTURE_2D, tile.texture);

                    this._tempMatrixData.set(tile.transformMatrix, i * 9);
                    this._tempTexCoords.set(tile.position, i * 8);
                }

                gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordsBuffer);
                gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._tempTexCoords.subarray(0, batchSize * 8));

                gl.bindBuffer(gl.ARRAY_BUFFER, this.matrixBuffer);
                gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._tempMatrixData.subarray(0, batchSize * 9));

                gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batchSize);
                currentIndex += batchSize;
            }

            this._renderOffset++;
        }

        gl.disable(gl.STENCIL_TEST);
        gl.bindVertexArray(null);

        return {
            texture: this.fpTexture,
            stencil: this.fpTextureClip
        };
    }

    unload() {
    }

    setDimensions(x, y, width, height, dataLayerCount) {
        // Double swapping required else collisions
        this._createOffscreenTexture("colorTextureA", width, height, dataLayerCount, this.gl.LINEAR);
        this._createOffscreenTexture("colorTextureB", width, height, dataLayerCount, this.gl.LINEAR);

        this._createOffscreenTexture("stencilTextureA", width, height, dataLayerCount, this.gl.LINEAR);
        this._createOffscreenTexture("stencilTextureB", width, height, dataLayerCount, this.gl.LINEAR);

        const gl  = this.gl;
        if (this.stencilClipBuffer) {
            gl.deleteRenderbuffer(this.stencilClipBuffer);
        }
        this.stencilClipBuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.stencilClipBuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, width, height);
    }


    /**
     * Destroy program. No arguments.
     */
    destroy() {
        // todo calls here might be frequent due to initialization... try to optimize, e.g. soft delete
        const gl = this.gl;
        gl.deleteFramebuffer(this.offScreenBuffer);
        this.offScreenBuffer = null;
        gl.deleteTexture(this.colorTextureA);
        this.colorTextureA = null;
        gl.deleteTexture(this.stencilTextureA);
        this.stencilTextureA = null;
        gl.deleteTexture(this.colorTextureB);
        this.colorTextureB = null;
        gl.deleteTexture(this.stencilTextureB);
        this.stencilTextureB = null;

        gl.deleteBuffer(gl.createRenderbuffer());
        this.stencilClipBuffer = null;

        gl.deleteVertexArray(this.firstPassVao);
        gl.deleteBuffer(this.matrixBuffer);
        gl.deleteBuffer(this.texCoordsBuffer);
        this.matrixBuffer = null;
        this.firstPassVao = null;
        this.texCoordsBuffer = null;

        this.firstPassVaoClip = gl.createVertexArray();
        gl.deleteVertexArray(this.firstPassVaoClip);
        // gl.deleteBuffer(this.positionsBuffer);
        // this.positionsBuffer = null;
        gl.deleteBuffer(this.matrixBufferClip);
        this.matrixBufferClip = null;
        gl.deleteBuffer(this.positionsBufferClip);
        this.positionsBufferClip = null;
    }

    _createOffscreenTexture(name, width, height, layerCount, filter) {
        layerCount = Math.max(layerCount, 1);
        const gl = this.gl;

        let texRef = this[name];
        if (texRef) {
            gl.deleteTexture(texRef);
        }

        this[name] = texRef = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, texRef);
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, width, height, layerCount);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
};
})(OpenSeadragon);
