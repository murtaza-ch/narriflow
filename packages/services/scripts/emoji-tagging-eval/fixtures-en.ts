import type { EvalScript } from "./fixtures";

// Written English transcripts for the emoji relevance evaluation: one sentence per line, the way a
// creator talks to camera. Word times are synthesised (fixtures.ts).

export const ENGLISH: readonly EvalScript[] = [
  {
    id: "en-business", language: "en", genre: "business advice", title: "Three pricing mistakes that keep you broke",
    text: `If you run a small business, this one is going to sting a little.
Most founders I talk to are not short of customers, they are short of margin.
Mistake number one is pricing by the hour.
The moment you charge for time, every improvement you make costs you money.
Charge for the result instead, and suddenly getting faster is a raise.
Mistake number two is giving a discount to every client who asks.
A discount trains people to wait, and it tells them your price was a guess.
If someone pushes back, add value, throw in a bonus call, but keep the number.
Mistake number three is hiding your price on the website.
People who cannot see a price assume it is expensive and leave.
When we put our packages on the homepage, sales calls went down and closed deals went up.
Last quarter we raised prices by thirty percent.
We lost two clients and our profit nearly doubled.
That is the whole game.
Fewer, better customers who pay you properly.
So this week, pick one offer and put a real price on it.
Write it down, say it out loud, and do not apologise for it.
Your bank account will thank you.`,
  },
  {
    id: "en-comedy", language: "en", genre: "comedy story", title: "My first date was a disaster",
    text: `Okay so let me tell you about the worst first date of my life.
I show up to this fancy Italian place in my best shirt, feeling like a movie star.
She orders the most expensive pasta on the menu, fine, no problem.
Then the waiter brings the bill and my card gets declined.
Twice.
I am sitting there sweating like I just ran a marathon.
So I tell her, give me one second, I need to call my bank.
I walk outside and I call my mom.
My mom picks up and the first thing she says is, are you hungry again?
I almost died laughing right there on the sidewalk.
She sends me the money, I walk back in like nothing happened.
And my date is already eating my dessert.
She looks at me and says, you took so long I thought you ran away.
Honestly I thought about it.
That pizza we got later was fire though.
We have been married for six years now.
She still brings up the card every single anniversary.`,
  },
  {
    id: "en-tech", language: "en", genre: "tech review", title: "I used this phone for a month",
    text: `I have been using this phone as my only phone for a whole month, so here is the honest review.
First, the battery is ridiculous.
I unplug it at seven in the morning and go to bed with forty percent left.
The screen is bright enough to read outside on a sunny beach.
The camera is where it gets interesting.
Daylight photos are sharp and the colours look natural, not cartoonish.
Night mode is good, but it takes about three seconds, so moving kids turn into ghosts.
The zoom lens is the weak spot.
Anything past five times looks like an oil painting.
Charging is fast, zero to full in about forty minutes, but there is no charger in the box.
Performance is smooth, games run without stutter and it barely gets warm.
The speakers are loud but a bit thin, so you will still want headphones.
Software updates are promised for seven years, which is huge if you keep a phone for a long time.
The price is the problem.
For this much money I expected a better zoom and a charger in the box.
So should you buy it?
If battery life matters most to you, yes, absolutely.
If you shoot a lot of zoom photos, wait for the sale or look elsewhere.`,
  },
  {
    id: "en-fitness", language: "en", genre: "fitness", title: "The only workout plan you need",
    text: `If you are a beginner in the gym, stop copying influencer workouts.
You need three things: lift heavy, eat enough protein, and sleep.
Start with the basics, squats, push ups, rows and deadlifts.
Three days a week is plenty when you are starting out.
Add a little weight every week, even if it is just one kilo.
That slow progress is what builds real muscle.
Cardio is not the enemy, walk ten thousand steps a day and your heart will love you.
Protein is the part everyone skips.
Aim for a palm sized portion at every meal, eggs, chicken, lentils, yogurt.
Drink water before you feel thirsty.
And please sleep seven to eight hours, because your muscles grow while you rest, not while you train.
Your first month will feel slow and you will be sore.
By month three your clothes fit differently and you climb stairs without stopping.
Take a photo on day one, you will want to see how far you came.
Do not chase perfect, chase consistent.
See you at the gym tomorrow morning.`,
  },
  {
    id: "en-cooking", language: "en", genre: "cooking", title: "Ten minute garlic butter noodles",
    text: `This is my ten minute dinner when I am too tired to cook.
Put a big pot of water on to boil and salt it like the sea.
While that heats up, chop four cloves of garlic really thin.
Melt two spoons of butter in a pan on low heat.
Add the garlic and let it sizzle until it smells amazing and turns golden.
Do not let it burn, burnt garlic tastes bitter.
Drop the noodles in the boiling water for about four minutes.
Save one cup of the pasta water before you drain them.
Toss the noodles into the butter with a splash of that water and a spoon of soy sauce.
Add chilli flakes if you like it spicy.
Crack an egg on top and stir fast so it turns creamy.
Finish with spring onions and a big handful of cheese.
Taste it, and add a squeeze of lemon if it needs brightness.
That is it, dinner in one pan and one pot.
It is so good I make it three times a week.`,
  },
  {
    id: "en-motivation", language: "en", genre: "motivational talk", title: "Nobody is coming to save you",
    text: `I need you to hear this today.
Nobody is coming to save you.
Not your boss, not your parents, not some lucky break.
Five years ago I was sleeping on a friend's couch with eleven dollars in my account.
Every morning I woke up scared and every night I went to bed with a plan I never started.
One day I decided to stop waiting.
I got up at five, I wrote for one hour before work, and I did it again the next day.
Most days nothing happened.
Nobody read it, nobody clapped.
But a year later that writing became a book.
Then the book became a business.
Your dreams do not need more time, they need a first step.
Fear will show up, let it ride in the back seat, just do not let it drive.
Small wins stack up like bricks until one day you look up and there is a house.
So tonight, write down one goal.
Tomorrow, take one step toward it.
You are stronger than you think.
Now go.`,
  },
  {
    id: "en-news", language: "en", genre: "news explainer with a tragic passage", title: "What the new rail line means for the city",
    text: `Here is what you need to know about the new rail line opening this week.
The line connects the airport to the city centre in twenty two minutes.
Before, the same trip by bus took more than an hour in traffic.
A single ticket costs three dollars, and students ride for half price.
The city says the line will take forty thousand cars off the road every day.
Construction took six years and went two years over schedule.
The project also had a dark chapter.
In twenty twenty three, a tunnel collapse killed four workers and injured eleven more.
Their families are still waiting for the full investigation report.
At the opening ceremony, the mayor held a minute of silence for the victims.
A memorial with their names now stands at the central station.
Critics say the budget doubled and the stations in poorer areas were cut.
Supporters say the line will bring jobs and cleaner air.
Trains run every five minutes at rush hour and every fifteen minutes at night.
The first week is free for everyone, so expect crowds.
If you ride it, tell me in the comments how it went.`,
  },
];
