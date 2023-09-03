const child_process = require("child_process")
const fs = require("fs")
const utils = require("./utils")
const { basedir } = require("../scripts_layered/lib")

var config = {
    basedir: "/tmp/cannon",
    programPath: "./mlgo/ml_mips/ml_mips.bin",
    modelPath: "./mlgo/examples/mnist/models/mnist/ggml-model-small-f32.bin",
    dataPath: "./mlgo/examples/mnist/models/mnist/input_7",
    modelName: "MNIST",
    
    curPhase: 0,
    totalPhase: 2,
    checkpoints: [],
    stepCount: [],
    challengeId: 0,

    prompt: "",

    execCommand: "python mlvm/scripts/server.py"
}

const MNIST_MIPS_MODEL = "./mlgo/examples/mnist/models/mnist/ggml-model-small-f32-big-endian.bin"
const MNIST_MIPS_PROGRAM =  "./mlgo/examples/mnist_mips/mlgo.bin"

function getConfig() {
    var newConfig = {
        basedir: config.basedir,
        programPath: config.programPath,
        modelPath: config.modelPath,
        dataPath: config.dataPath,
        modelName: config.modelName,

        curPhase: config.curPhase,
        totalPhase: config.totalPhase,
        checkpoints: [...config.checkpoints],
        stepCount: [...config.stepCount],
        challengeId: config.challengeId,

        prompt: config.prompt,

        execCommand: config.execCommand
    }
    return newConfig
}

function copyConfig(config) {
    return JSON.parse(JSON.stringify(config))
}

function genGoldenImage(config) {
    var command = "mlvm/mlvm --mp" + " --basedir="+config.basedir + " --program="+config.programPath + " --model="+config.modelPath + " --data="+config.dataPath + " --modelName="+config.modelName + " --curPhase="+config.curPhase + " --totalPhase="+config.totalPhase + " --checkpoints="+JSON.stringify(config.checkpoints) + " --stepCount="+JSON.stringify(config.stepCount) + " --execCommand="+JSON.stringify(config.execCommand)
    console.log(command)
    child_process.execSync(command, {stdio: 'inherit'})
    console.log("golden.json is at " + config.basedir+"/checkpoint/[0].json")
    try {
        cpCommand = "cp " + config.basedir + "/checkpoint/[0,0].json " + config.basedir+"/checkpoint/[0].json"
        child_process.execSync(cpCommand, {stdio: 'inherit'})
    } catch (error) {
        // console.log(error)
    }
    
}


async function deployOPMLContract(config) {
    const basedir=config.basedir
    let [c, m, mm] = await utils.deployContract(basedir)
    let json = {
    "MPChallenge": c.address,
    "MIPS": m.address,
    "MIPSMemory": mm.address,
    }
    console.log("deployed", json)
    fs.writeFileSync(basedir + "/deployed.json", JSON.stringify(json))
    return json
}

// client
async function initiateOPMLRequest(config) {
    genGoldenImage(config)
    info = await deployOPMLContract(config)
    return info
}

// run program
function runProgram(config) {
    const programPath = MNIST_MIPS_PROGRAM
    const modelPath = MNIST_MIPS_MODEL
    var command = "mlvm/mlvm --mipsVMCompatible" + " --basedir="+config.basedir + " --program="+programPath + " --model="+modelPath + " --data="+config.dataPath
    console.log(command)
    child_process.execSync(command, {stdio: 'inherit'})
    console.log("checkpoint_final.json is at " + config.basedir+"/checkpoint_final.json")
}

function getOutput(basedir=config.basedir) {
    let output = fs.readFileSync(basedir+"/output")
    return output
    // return '0x' + output.toString('hex')
}

// submitter
async function uploadResult(basedir=config.basedir) {
    let [c, m, mm] = await utils.deployed(basedir)
    output = getOutput(basedir)
    c.uploadResult(output)
    return output
}

async function getProposedResults(basedir=config.basedir) {
    let [c, m, mm] = await utils.deployed(basedir)
    // console.log(c)
    result = (await c.proposedResults())
    return result
}

// challenger
async function startChallenge(config) {
    const basedir=config.basedir
    let [c, m, mm] = await utils.deployed(basedir)
    let startTrie = JSON.parse(fs.readFileSync(basedir+"/checkpoint/[0].json"))
    // let finalTrie = JSON.parse(fs.readFileSync(basedir+"/checkpoint_final.json"))
    let finalTrie = startTrie // for convenience now 
    let preimages = Object.assign({}, startTrie['preimages'], finalTrie['preimages']);
    const finalSystemState = finalTrie['root']
  
    let args = [finalSystemState, finalTrie['stepCount'][0], config.totalPhase]
    let cdat = c.interface.encodeFunctionData("initiatePureComputationChallenge", args)
    let nodes = await utils.getTrieNodesForCall(c, c.address, cdat, preimages)
  
    // run "on chain"
    for (n of nodes) {
      await mm.AddTrieNode(n)
    }

    let ret = await c.initiatePureComputationChallenge(...args)
    let receipt = await ret.wait()
    // ChallengeCreated event
    let challengeId = receipt.events[0].args['challengeId'].toNumber()
    console.log("new challenge with id", challengeId)

    return challengeId
}

const RespondState = {
    END: 'END',
    NEXT: "NEXT",
    RESPOND: 'RESPOND',
    WAIT: 'WAIT'
}

// challenger and submitter
// return state
async function respond(challengeId, isChallenger, config) {
    // console.log("start respond")
    let [c, m, mm] = await utils.deployed(config.basedir)
    let step = (await c.getStepNumber(challengeId)).toNumber()
    console.log("searching step", step)

    let curLayer = (await c.getCurrentLayer(challengeId)).toNumber()
    console.log("current layer: ", curLayer)
    config.curPhase = curLayer

    let totalLayer = (await c.getTotalLayer(challengeId)).toNumber()

    let nodeID = (await c.getNodeID(challengeId)).toNumber()
    let isSearching = (await c.isSearching(challengeId))
  

    for (var i = 0; i <= curLayer; i++) {
        config.checkpoints[i] = (await c.getCheckpoint(challengeId, i)).toNumber()
        config.stepCount[i] = (await c.getStepcount(challengeId, i)).toNumber()
    }
    // config.checkpoints[curLayer] = step
    // if (curLayer == 1) {
    //     config.checkpoints[0] = nodeID    
    // }

    var respondResult = {
        config: config,
        state: RespondState.RESPOND,
        root: null,
    }
    

    if (curLayer == totalLayer - 2) { // the last 2nd
        nodeID = step
        if (!isSearching) {
            console.log("enter the next layer")
            // [xxx, 0]
            let newConfig = copyConfig(config)
            newConfig.dataPath = newConfig.basedir + "/data/" + JSON.stringify(newConfig.checkpoints) + ".dat"
            newConfig.checkpoints.push(0)
            newConfig.curPhase += 1
            let startTrie = utils.getTrieAtStep(newConfig)

            newConfig = copyConfig(config)
            newConfig.dataPath = newConfig.basedir + "/data/" + JSON.stringify(newConfig.checkpoints) + ".dat"
            newConfig.checkpoints.push(-1)
            newConfig.curPhase += 1
            let finalTrie = utils.getTrieAtStep(newConfig)

            console.log(challengeId, startTrie['root'], finalTrie['root'], finalTrie['stepCount'])
            ret = await c.toNextLayer(challengeId, startTrie['root'], finalTrie['root'], finalTrie['stepCount'][newConfig.curPhase])
            let receipt = await ret.wait()
            console.log("to next layer done", receipt.blockNumber)

            respondResult.root = startTrie['root']
            respondResult.state = RespondState.NEXT
            return respondResult
            // return RespondState.NEXT
        } else {
            const proposed = await c.getProposedState(challengeId)
            const isProposing = proposed == "0x0000000000000000000000000000000000000000000000000000000000000000"
            if (isProposing != isChallenger) {
                console.log("bad challenger state")
                return RespondState.WAIT
            }
            console.log("isProposing", isProposing)

            newConfig = copyConfig(config)
            let thisTrie = utils.getTrieAtStep(newConfig)
            const root = thisTrie['root']
            console.log("new root", root)

            let ret
            if (isProposing) {
                ret = await c.proposeState(challengeId, root)
            } else {
                ret = await c.respondState(challengeId, root)
            }
            let receipt = await ret.wait()
            console.log("done", receipt.blockNumber)

            respondResult.root = root
            respondResult.state = RespondState.RESPOND
            return respondResult
            // return RespondState.RESPOND
        }

    } else if (curLayer == totalLayer - 1) { // the last one
        // curlayer = 1 // mipsvm
        if (!isSearching) {
            console.log("search is done")
            return RespondState.END
        }

        // see if it's proposed or not
        const proposed = await c.getProposedState(challengeId)
        const isProposing = proposed == "0x0000000000000000000000000000000000000000000000000000000000000000"
        if (isProposing != isChallenger) {
            console.log("bad challenger state")
            return RespondState.WAIT
        }
        console.log("isProposing", isProposing)
        newConfig = copyConfig(config)
        newConfig.dataPath = newConfig.basedir + "/data/" + JSON.stringify(newConfig.checkpoints.slice(0,-1)) + ".dat"
        let thisTrie = utils.getTrieAtStep(newConfig)
        const root = thisTrie['root']
        console.log("new root", root)

        let ret
        if (isProposing) {
            ret = await c.proposeState(challengeId, root)
        } else {
            ret = await c.respondState(challengeId, root)
        }
        let receipt = await ret.wait()
        console.log("done", receipt.blockNumber)

        respondResult.root = root
        respondResult.state = RespondState.RESPOND
        return respondResult
        // return RespondState.RESPOND
    } else {
        // [0...totalLayer - 2]
        if (!isSearching) {
            console.log("enter the next layer")
            let newConfig = copyConfig(config)
            newConfig.checkpoints.push(0)
            newConfig.curPhase += 1
            let startTrie = utils.getTrieAtStep(newConfig)

            newConfig = copyConfig(config)
            newConfig.checkpoints.push(-1)
            newConfig.curPhase += 1
            let finalTrie = utils.getTrieAtStep(newConfig)

            console.log(challengeId, startTrie['root'], finalTrie['root'], finalTrie['stepCount'])
            ret = await c.toNextLayer(challengeId, startTrie['root'], finalTrie['root'], finalTrie['stepCount'][newConfig.curPhase])
            let receipt = await ret.wait()
            console.log("to next layer done", receipt.blockNumber)

            respondResult.root = startTrie['root']
            respondResult.state = RespondState.NEXT
            return respondResult
            // return RespondState.NEXT
        } else {
            const proposed = await c.getProposedState(challengeId)
            const isProposing = proposed == "0x0000000000000000000000000000000000000000000000000000000000000000"
            if (isProposing != isChallenger) {
                console.log("bad challenger state")
                return RespondState.WAIT
            }
            console.log("isProposing", isProposing)

            newConfig = copyConfig(config)
            let thisTrie = utils.getTrieAtStep(newConfig)
            const root = thisTrie['root']
            console.log("new root", root)

            let ret
            if (isProposing) {
                ret = await c.proposeState(challengeId, root)
            } else {
                ret = await c.respondState(challengeId, root)
            }
            let receipt = await ret.wait()
            console.log("done", receipt.blockNumber)

            respondResult.root = root
            respondResult.state = RespondState.RESPOND
            return respondResult
            // return RespondState.RESPOND
        }
    }
}

async function assert(challengeId, isChallenger, config) {
    let [c, m, mm] = await utils.deployed(config.basedir)
    let step = (await c.getStepNumber(challengeId)).toNumber()
    console.log("searching step", step)

    let nodeID = (await c.getNodeID(challengeId)).toNumber()
    console.log("nodeID: ", nodeID)

    let curLayer = (await c.getCurrentLayer(challengeId)).toNumber()
    console.log("curLayer: ", curLayer)

    // config.checkpoints[curLayer] = step
    // config.checkpoints[0] = nodeID

    for (var i = 0; i <= curLayer; i++) {
        config.checkpoints[i] = (await c.getCheckpoint(challengeId, i)).toNumber()
        config.stepCount[i] = (await c.getStepcount(challengeId, i)).toNumber()
    }
  
    var assertResult = {
        state: "OK",
        events: []
    }

    if (await c.isSearching(challengeId)) {
      console.log("search is NOT done")
      assertResult.state = "NOT DONE"
      return assertResult
    }

    let cdat
    if (isChallenger) {
      // challenger declare victory
      cdat = c.interface.encodeFunctionData("confirmStateTransition", [challengeId])
    } else {
      // defender declare victory
      // note: not always possible
      cdat = c.interface.encodeFunctionData("denyStateTransition", [challengeId])
    }
  
    let newConfig = copyConfig(config)
    newConfig.dataPath = newConfig.basedir + "/data/" + JSON.stringify(newConfig.checkpoints.slice(0,-1)) + ".dat"
    let startTrie = utils.getTrieAtStep(newConfig)
    // let startTrie = utils.getTrieAtStep(basedir, config.programPath, config.modelPath, config.dataPath, step)


    newConfig = copyConfig(config)
    newConfig.checkpoints[(newConfig.checkpoints).length - 1] += 1 // the next step
    newConfig.dataPath = newConfig.basedir + "/data/" + JSON.stringify(newConfig.checkpoints.slice(0,-1)) + ".dat"
    let finalTrie = utils.getTrieAtStep(newConfig)
    // let finalTrie = utils.getTrieAtStep(basedir, config.programPath, config.modelPath, config.dataPath, step+1)
    
    let preimages = Object.assign({}, startTrie['preimages'], finalTrie['preimages']);
  
    let nodes = await utils.getTrieNodesForCall(c, c.address, cdat, preimages)
    for (n of nodes) {
      await mm.AddTrieNode(n)
    }
  
    let ret
    if (isChallenger) {
      ret = await c.confirmStateTransition(challengeId)
    } else {
      ret = await c.denyStateTransition(challengeId)
    }
  
    let receipt = await ret.wait()
    console.log(receipt.events.map((x) => x.event))
    assertResult.state = "OK"
    assertResult.events = receipt.events.map((x) => x.event)
    return assertResult
}

module.exports = {
    initiateOPMLRequest, 
    runProgram,
    uploadResult, 
    getProposedResults,
    respond,
    assert,
    config,
    getOutput,
    startChallenge,
    getConfig,
}