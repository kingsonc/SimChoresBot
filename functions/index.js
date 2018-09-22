const functions = require('firebase-functions');
const admin = require('firebase-admin');
const request = require('request-promise');

const serviceAccount = require("./simchores-bot-firebase-adminsdk-47vqo-b0ba24c50a.json");
const slack_token_js = require("./slack_tokens.js");
const slack_token = slack_token_js.prod_token;

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://simchores-bot.firebaseio.com"
});

var db = admin.firestore();
db.settings({
    // Removes the annoying deprecating soon warning in Firebase functions log
    // Does not affectt he bot's functioning
    timestampsInSnapshots: true
});

exports.rotate = functions.https.onRequest((req, res) => {
    /* Main SimChores rotation function. Triggered by slack API slash command
     * It is very poorly written and hacked together but it works for now
     * Needs a proper refactoring if future updates are needed
     * Tasks for a future Lego Day!
     */
    console.log("rotate v60");
    var job_assigned = {};
    var job_doc_data = {};

    return db.collection('simployees').get()
    .then(snapshot => {
        var histories = {};
        var assigned = [];

        snapshot.forEach(person => {
            for (var job in person.data().history) {
                // Create a 2-dimensional array of how many times each simployee has done each chore
                // Reduces the odds of someone repeating a chore before everyone has done it once
                histories[job] = histories[job] || [];
                histories[job].push([person.id, person.data().history[job]]);
            }
        });

        // Use ES6 promises to wait for all Firestore async calls to return
        var promiseChain = Promise.resolve();

        for (var job in histories) {
            histories[job].sort((a,b) => {
                return a[1] - b[1];
            });

            var nextPromise = job => () => {
                return db.collection('jobs').doc(job).get()
                .then(doc => {
                    job_doc_data[job] = doc.data();

                    // No of persons needed for the job
                    var persons = job_doc_data[job].persons;
                    // Check which simployees do not have a chore for this month yet
                    var available = histories[job].filter(el => {
                        return assigned.indexOf(el[0]) < 0;
                    });
                    // Take the required number of simployees needed for the chore
                    var assignee = available.slice(0, persons);

                    job_assigned[job] = [];
                    for (person in assignee) {
                        assigned.push(assignee[person][0]);
                        job_assigned[job].push(assignee[person][0]);
                    }

                    // Update Firestore job document
                    return doc.ref.update({assign: job_assigned[job]});
                });
            }
            promiseChain = promiseChain.then(nextPromise(job));
        }
        return promiseChain;
    }).then(() => {
        // This section sends a PM to everyone about their new chore
        var promiseChain = Promise.resolve();
        for (var job in job_assigned) {
            for (var person in job_assigned[job]) {
                var simployee = job_assigned[job][person];

                var nextPromise = (job, simployee) => () => {
                    return db.collection('simployees').doc(simployee).get()
                    .then(doc => {
                        // Updates the simchore history dictionary for each simployee
                        var newHistory = doc.data().history;
                        newHistory[job] += 1;
                        return [doc.data().id, newHistory];
                    }).then(data => {
                        id = data[0];
                        newHistory = data[1];
                        // Sends PM through slackbot
                        return request({
                            uri: "https://slack.com/api/chat.postMessage",
                            method: "GET",
                            qs: {
                                token: slack_token,
                                channel: id,
                                attachments: job_doc_data[job].initial_msg.attachments
                            }
                        });
                    }).then(() => {
                        // Update history dictionary on Firebase
                        return db.collection('simployees').doc(simployee).update({
                            history: newHistory
                        });
                    }).catch(err => {
                        console.log(err);
                    });
                }
                promiseChain = promiseChain.then(nextPromise(job, simployee));
            }
        }
        return promiseChain;
    }).then(() => {
        // Send overall rota onto #SimChores2 slack channel
        return request({
            uri: "https://slack.com/api/chat.postMessage",
            method: "GET",
            qs: {
                token: slack_token,
                channel: "CC60DNCG1",
                attachments: '[{"pretext": "This month\'s SimChores rota!", "text": "Amazonians: ' + job_assigned['Amazonian'] + '"}, {"text": "Beerwench: ' + job_assigned['Beerwench'] + '"}, {"text": "Castle Guard: ' + job_assigned['Castle Guard'] + '"}, {"text": "Foodie: ' + job_assigned['Foodie'] + '"}, {"text": "Postie: ' + job_assigned['Postie'] + '"}, {"text": "SimSocial: ' + job_assigned['SimSocial'] + '"}, {"text": "Stockist: ' + job_assigned['Stockist'] + '"}, {"text": "Tidy Whip: ' + job_assigned['Tidy Whip'] + '"}, {"text": "Sub 1: ' + job_assigned['Sub 1'] + '"}, {"text": "Sub 2: ' + job_assigned['Sub 2'] + '"}, {"text": "Sub 3: ' + job_assigned['Sub 3'] + '"}]'
            }
        });
    }).then(rr => {
        res.status(200).json(job_assigned);
    });
});

exports.new_user = functions.https.onRequest((req, res) => {
    // Add new simployee into the database
    console.log("new user v7");

    // Find new simployee's slack ID
    return request({
        uri: "https://slack.com/api/users.lookupByEmail",
        method: "GET",
        qs: {
            token: slack_token,
            email: req.query.email
        }
    }).then(rr => {
        slack_obj = JSON.parse(rr);
        if (slack_obj['ok'] == false) {
            // Most likely wrong email (?)
            res.send("Creating new user failed. Error: " + slack_obj['error']);
            return;
        }
        return slack_obj['user']['id'];
    }).then(slack_id => {
        // Insert new simployee document into Firestore
        return db.collection('simployees').doc(req.query.name).set({
            history: {
                'Amazonian': 0,
                'Beerwench': 0,
                'Castle Guard': 0,
                'Foodie': 0,
                'Postie': 0,
                'SimSocial': 0,
                'Stockist': 0,
                'Sub 1': 0,
                'Sub 2': 0,
                'Sub 3': 0,
                'Tidy Whip': 0
            },
            id: slack_id
        });
    }).then(() => {
        res.status(200).send("Added simployee " + req.query.name + " to SimChoresBot!");
    });
});
