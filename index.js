const express = require('express');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');
require('dotenv').config()
const jwt = require('jsonwebtoken');
const app = express();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const port = process.env.PORT || 5000;

//middle wares
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Dental Lab express server running!')

})
const verifyJWT = (req, res, next) => {

    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send({ message: 'Unauthorized access' })
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'Forbidden access' });
        }
        req.decoded = decoded;
        next();
    })

}

//mongo db connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.cwjhhvi.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

//mongodb crud function
async function run() {
    try {
        //document collections
        const appointmentOptionCollection = client.db('DentalLab').collection('appointmentOptions');
        const bookingCollection = client.db('DentalLab').collection('bookings');
        const userCollection = client.db('DentalLab').collection('users');
        const doctorCollection = client.db('DentalLab').collection('doctors');
        const paymentCollection = client.db('DentalLab').collection('payments');

        //verify admin 
        //this should be used after verifyJWT
        const verifyAdmin = async (req, res, next) => {
            const decodedEmail = req.decoded.email;
            const query = { email: decodedEmail }
            const user = await userCollection.findOne(query);
            if (user?.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' })
            }
            next();
        }

        //appointment options get api
        app.get('/appointmentOptions', async (req, res) => {
            const date = req.query.date;
            const query = {};
            const options = await appointmentOptionCollection.find(query).toArray()
            //get the bookings of the provided date
            const bookingQuery = { appointmentDate: date }
            const alreadyBooked = await bookingCollection.find(bookingQuery).toArray();
            options.forEach(option => {
                const optionBooked = alreadyBooked.filter(book => book.treatment === option.name)
                const bookedSlots = optionBooked.map(book => book.slot)
                remainingSlots = option.slots.filter(slot => !bookedSlots.includes(slot))
                option.slots = remainingSlots;
                // console.log(date, remainingSlots);
            })
            res.send(options);
        })

        //lockup aggregate 
        app.get('/v2/appointmentOptions', async (req, res) => {
            const date = req.query.date;
            // console.log(date);
            const options = await appointmentOptionCollection.aggregate([
                {
                    //this part of code picks the bookings for a specific date from each option
                    $lookup: {
                        from: 'bookings',
                        localField: 'name',
                        foreignField: 'treatment',
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $eq: ['$appointmentDate', date]
                                    }
                                }
                            }
                        ],
                        as: 'booked'
                    }
                },
                //this part of code picks the booked slots from the above booked bookings
                {
                    $project: {
                        name: 1,
                        slots: 1,
                        price: 1,
                        bookedSlots: {
                            $map: {
                                input: '$booked',
                                as: 'book',
                                in: '$$book.slot'
                            }
                        }
                    }
                },
                //this part picks the remaining slots for each option
                {
                    $project: {
                        name: 1,
                        price: 1,
                        slots: {
                            $setDifference: ['$slots', '$bookedSlots']
                        }
                    }
                }
            ]).toArray()
            res.send(options);
        })
        //get a specific booking
        app.get('/bookings/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) };
            const result = await bookingCollection.findOne(query);
            res.send(result);
        })

        //get the user specific bookings
        app.get('/bookings', verifyJWT, async (req, res) => {
            const email = req.query.email;
            console.log(req.headers.authorization);
            const decodedEmail = req.decoded.email;
            if (email !== decodedEmail) {
                return res.status(401).send({ message: 'Unauthorized access' });
            }
            const query = {
                email: email
            }
            const bookings = await bookingCollection.find(query).toArray();
            res.send(bookings);
        })

        //booking post api
        app.post('/bookings', async (req, res) => {
            const booking = req.body;
            // console.log(booking);
            const query = {
                appointmentDate: booking.appointmentDate,
                email: booking.email,
                treatment: booking.treatment
            }
            //the above query prevents one user to to book multiple appointment in a single day
            const alreadyBooked = await bookingCollection.find(query).toArray();
            if (alreadyBooked.length) {
                const message = `You already have a booking on ${booking.appointmentDate}`
                return res.send({ acknowledged: false, message })
            }
            const result = await bookingCollection.insertOne(booking);
            res.send(result)
        })
        //send token to authorized to valid users
        app.get('/jwt', async (req, res) => {
            const email = req.query.email;
            const query = { email: email };
            const user = await userCollection.findOne(query);
            const secret = process.env.ACCESS_TOKEN;
            if (user) {
                const token = jwt.sign({ email }, secret, { expiresIn: '10h' })
                return res.send({ accessToken: token })
            }
            res.send({ accessToken: "" });
        })
        // checking if an user is admin or not
        app.get('/users/admin/:email', async (req, res) => {
            const email = req.params.email;
            const query = { email: email };
            const user = await userCollection.findOne(query);
            res.send({ isAdmin: user?.role === 'admin' });
        })
        //add admin role api
        app.put('/users/admin/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: ObjectId(id) };
            const options = { upsert: true };
            const updatedDoc = {
                $set: {
                    role: 'admin'
                }
            }
            const result = await userCollection.updateOne(filter, updatedDoc, options);
            res.send(result)
        })
        //update a field to existing data
        // app.get('/updateDocs', async (req, res) => {
        //     const filter = {};
        //     updatedDoc = {
        //         $set: {
        //             price: 99
        //         }
        //     }
        //     options = { upsert: true };
        //     const result = await appointmentOptionCollection.updateMany(filter, updatedDoc, options)
        //     res.send(result);
        // })

        // get users api
        app.get('/users', verifyJWT, async (req, res) => {
            const decodedEmail = req.decoded.email;
            const adminQuery = { email: decodedEmail };
            const user = await userCollection.findOne(adminQuery);
            if (user?.role !== 'admin') {
                return res.status(401).send({ message: 'unauthorized access' });
            }
            const query = {};
            const result = await userCollection.find(query).toArray();
            res.send(result);
        })
        //user data save
        app.post('/users', async (req, res) => {
            const user = req.body;
            const result = await userCollection.insertOne(user);
            res.send(result);
        })
        //
        app.get('/appointmentSpecialty', async (req, res) => {
            const query = {};
            const result = await appointmentOptionCollection.find(query).project({ name: 1 }).toArray()
            res.send(result);
        })
        //get doctors api
        app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const query = {};
            const doctors = await doctorCollection.find(query).toArray();
            res.send(doctors);
        })
        //add doctor api
        app.post('/doctors', verifyJWT, async (req, res) => {
            const doctor = req.body;
            const result = await doctorCollection.insertOne(doctor);
            res.send(result);
        })
        //delete a doctor api
        app.delete('/doctors/:id', verifyJWT, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: ObjectId(id) };
            const result = await doctorCollection.deleteOne(filter);
            res.send(result);
        })
        //post payments api
        app.post('/payments', async (req, res) => {
            const payment = req.body;
            const result = await paymentCollection.insertOne(payment);
            const id = payment.bookingID;
            const query = { _id: ObjectId(id) };
            const updatedDoc = {
                $set: {
                    paid: true,
                    transactionID: payment.transactionID
                }
            }
            const updatedResult = await bookingCollection.updateOne(query, updatedDoc);
            res.send(result);
        })

        //stripe payment api
        app.post('/create-payment-intent', async (req, res) => {
            const booking = req.body;
            const price = booking.price;
            const amount = price * 100;
            const paymentIntent = await stripe.paymentIntents.create({
                amount,
                currency: "usd",
                "payment_method_types": [
                    "card"
                ],
            })
            res.send({
                clientSecret: paymentIntent.client_secret,
            });

        })
    }
    finally {


    }
}
run().catch(console.dir);



app.listen(port, () => {
    console.log(`Dental server running on port: ${port}`);
})