const prompts = require("prompts");
const fs = require("fs");
const path = require("path");
const https = require("https");
const cp = require("child_process");

const config = require("./config.json");
const initialPrompts = fs.existsSync("./.initialprompts.json") ? require("./.initialprompts.json") : { };

(async () => {
    // Ask for old install path for syncing
    const oldInstallPath = await prompt("Sync mods from an old install (optional)", "oldInstallPath");
   
    let oldMods;
    if (oldInstallPath) {
        const oldModsPath = path.join(oldInstallPath, "Plugins");

        // Get old mods from Plugins folder of old installation
        oldMods = fs.existsSync(oldModsPath) ? fs.readdirSync(oldModsPath).filter(i => path.extname(i) == ".dll").map(i => path.basename(i, path.extname(i))) : null
        if (!oldMods) console.log("Found no mods!");
        else console.log(`Found ${oldMods.length} mods!`);
    }
    
    // Ask for new installation path and version
    const installPath = await prompt("Enter the path to your new Beat Saber directory", "installPath", "You must enter the path to your new Beat Saber directory!");
    if (!installPath) return;
    const version = await prompt("Enter the version of your current Beat Saber install", null, "You must enter the version of your current Beat Saber install!", "text", { initial: fs.existsSync(path.join(installPath, "BeatSaberVersion.txt")) ? fs.readFileSync(path.join(installPath, "BeatSaberVersion.txt"), "utf-8").split("_")[0] : undefined });
    if (!version) return;

    // Get mods of that version
    console.log(`Searching for mods using version ${version}...`);
    const newMods = await getMods(version, config.modStatus);
    if (!newMods?.length) return console.log(`No mods where found for version ${version}!`);
    
    // Ask to select mods with found old mods being pre-selected (if any)
    const selectedMods = await prompt("Select mods to install", null, null, "multiselect", { choices: newMods.map(i => ({
        title: `${i.name}${config.includeModDescriptions ? ` - ${i.description}` : ""}`,
        value: i,
        selected: oldMods ? (matchMods(oldMods, i.name) ? true : false) : false
    })) });
    if (!selectedMods?.length) return;

    // Add additional dependencies
    let additionalDependencies = 0;
    selectedMods.forEach(mod => {
        mod.dependencies.forEach(dep => {
            if (!selectedMods.find(i => i._id == dep._id)) {
                additionalDependencies++;
                selectedMods.push(dep);
            }
        });
    });

    if (config.excludeBSIPA) {
        const bsipaIndex = selectedMods.findIndex(i => i.name == "BSIPA");
        if (bsipaIndex != -1) selectedMods.splice(bsipaIndex, 1);
    }

    // Ask for confirmation
    const confirmation = await prompt(`Ready to install ${selectedMods.length} mods (${additionalDependencies} additional dependencies)?`, null, null, "confirm");
    if (!confirmation) return;

    console.log(`Downloading ${selectedMods.length} mods${oldMods ? (oldMods.length - selectedMods.length != 0 ? (oldMods.length > selectedMods.length ? `, ${oldMods.length - selectedMods.length} mod(s) less than your old install had` : `, ${selectedMods.length - oldMods.length} mod(s) more than your old install had`) : "") : ""}`); // oh god

    // Download and extract all mods
    await (async function downloadMods(index) {
        const mod = selectedMods[index];

        // Download
        console.log(`Downloading mod ${mod.name}`);
        const modUrl = mod.downloads[0].url;
        const modSavePath = path.join(config.zippedModsPath, path.basename(modUrl));

        try {
            await downloadMod(modUrl, modSavePath)
        } catch (err) {
            console.log(`Failed to download mod ${mod.name}!`);
            if (selectedMods[index + 1]) downloadMods(index + 1);
            return;
        }

        // Extract
        console.log(`Extracting mod ${mod.name}`);
        cp.exec(`${config["7zPath"]} x "${modSavePath}" -o"${path.normalize(installPath)}" -y`, err => {
            if (err) console.log(`Failed to extract mod ${mod.name}!`);
            if (!config.keepZippedMods) fs.rmSync(modSavePath);
            if (selectedMods[index + 1]) return downloadMods(index + 1);
        });
    })(0);
})();

function updateInitialPrompts(prompt, value) {
    initialPrompts[prompt] = value;
    fs.writeFileSync("./.initialprompts.json", JSON.stringify(initialPrompts, null, 4));
}

function prompt(message, name, requiredText, type = "text", options = { }) {
    return new Promise(async resolve => {
        const input = await prompts({
            message,
            type,
            name: name || "prompt",
            initial: config.initials ? initialPrompts[name] : undefined,
            validate: i => requiredText ?
                (i ? true : requiredText) :
                true,
            ...options,
        }).then(i => i[name || "prompt"]);

        if (name && input && config.initials) updateInitialPrompts(name, input);
        resolve(input);
    });
}

function getMods(version, status = "approved") {
    return new Promise((resolve, reject) => {
        https.request({
            host: "beatmods.com",
            path: `/api/v1/mod?status=${status}&gameVersion=${version}`,
        }, res => {
            let chunks = [];

            res.on("data", i => chunks.push(i));
            res.on("end", () => {
                const data = Buffer.concat(chunks);
                let json;

                try {
                    json = JSON.parse(data.toString());
                } catch (err) { return reject(err) };
                
                resolve(json);
            });
        }).end();
    });
}

function matchMods(mods, mod2) {
    // This can indeed be better, like the rest of this code
    mod2 = mod2.toLowerCase();
    mod2 = mod2.replace(/ /g, "");

    return mods.filter(mod1 => {
        mod1 = mod1.toLowerCase();
        mod1 = mod1.replace(/ /g, "");

        return mod1 == mod2 ||
        mod1.includes(mod2) ||
        mod2.includes(mod1)   
    }
    )[0] ? true : false;
}

function downloadMod(url, savePath) {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(savePath)) return resolve();

        https.request({
            host: "beatmods.com",
            path: url.replace(/ /g, "%20")
        }, res => {
            if (res.statusCode != 200) reject(res);

            if (!fs.existsSync(config.zippedModsPath)) fs.mkdirSync(config.zippedModsPath);

            const stream = fs.createWriteStream(savePath);
            stream.on("error", err => reject(err));
            stream.on("close", () => resolve());

            res.on("data", i => stream.write(i));
            res.on("end", () => stream.end());
            res.on("error", err => {
                stream.destroy();
                reject(err);
            });
        }).end();
    });
}